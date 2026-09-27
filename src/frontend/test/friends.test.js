// Tests for /friends and /users/search (friends.js). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-friends-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-friends-media-"));

const app = require("../app");

let server;
let baseUrl;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.DATABASE_PATH, { force: true });
    fs.rmSync(process.env.MEDIA_ROOT, { recursive: true, force: true });
});

async function request(method, urlPath, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
}

// Each test makes its own accounts: "one active session per user" means a
// second login for the same account would invalidate the first test's token.
let userCounter = 0;
async function signupAndLogin(prefix, password = "password123") {
    const username = `${prefix}${userCounter++}`;
    const email = `${username}@example.com`;
    await request("POST", "/signup", { body: { username, email, password } });
    const token = (await request("POST", "/login", { body: { email, password } })).body.token;
    return { username, email, token };
}

test("a request has to be accepted before either side is a friend", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.status, "pending");

    assert.deepEqual((await request("GET", "/friends", { token: ada.token })).body, []);
    assert.deepEqual((await request("GET", "/friends", { token: grace.token })).body, []);

    const incoming = await request("GET", "/friends/requests", { token: grace.token });
    assert.equal(incoming.body.incoming.length, 1);
    assert.equal(incoming.body.incoming[0].user.username, ada.username);
    assert.equal(incoming.body.outgoing.length, 0);

    const outgoing = await request("GET", "/friends/requests", { token: ada.token });
    assert.equal(outgoing.body.outgoing.length, 1);
    assert.equal(outgoing.body.incoming.length, 0);

    const accepted = await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, {
        token: grace.token,
    });
    assert.equal(accepted.status, 200);

    // Accepted once, friends in both directions.
    assert.deepEqual(
        (await request("GET", "/friends", { token: ada.token })).body.map((f) => f.username),
        [grace.username]
    );
    assert.deepEqual(
        (await request("GET", "/friends", { token: grace.token })).body.map((f) => f.username),
        [ada.username]
    );
});

test("only the addressee can accept, and only once", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");
    const mallory = await signupAndLogin("mallory");

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    const id = sent.body.friendship_id;

    // 404, not 403: don't confirm the id exists to someone it isn't for.
    assert.equal((await request("POST", `/friends/requests/${id}/accept`, { token: mallory.token })).status, 404);
    // Not even the sender can accept their own request.
    assert.equal((await request("POST", `/friends/requests/${id}/accept`, { token: ada.token })).status, 404);

    assert.equal((await request("POST", `/friends/requests/${id}/accept`, { token: grace.token })).status, 200);
    // Already accepted -- it's no longer pending.
    assert.equal((await request("POST", `/friends/requests/${id}/accept`, { token: grace.token })).status, 404);
});

test("declining removes the request and lets them try again", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    assert.equal(
        (await request("POST", `/friends/requests/${sent.body.friendship_id}/decline`, { token: grace.token })).status,
        200
    );

    assert.equal((await request("GET", "/friends/requests", { token: grace.token })).body.incoming.length, 0);
    assert.deepEqual((await request("GET", "/friends", { token: ada.token })).body, []);

    const again = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    assert.equal(again.status, 201);
});

test("asking back someone who already asked you makes you friends", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");

    await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    const back = await request("POST", "/friends/requests", { token: grace.token, body: { username: ada.username } });

    assert.equal(back.status, 200);
    assert.equal(back.body.status, "accepted");
    assert.equal((await request("GET", "/friends", { token: ada.token })).body.length, 1);
});

test("duplicate, self and unknown friend requests are rejected", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");

    assert.equal(
        (await request("POST", "/friends/requests", { token: ada.token, body: { username: ada.username } })).status,
        400
    );
    assert.equal(
        (await request("POST", "/friends/requests", { token: ada.token, body: { username: "nobody-here" } })).status,
        404
    );
    assert.equal(
        (await request("POST", "/friends/requests", { token: ada.token, body: { username: "" } })).status,
        400
    );

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    assert.equal(
        (await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } })).status,
        409
    );

    await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, { token: grace.token });
    assert.equal(
        (await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } })).status,
        409
    );
});

test("either side can remove the friendship", async () => {
    const ada = await signupAndLogin("ada");
    const grace = await signupAndLogin("grace");

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, { token: grace.token });

    const graceId = (await request("GET", "/friends", { token: ada.token })).body[0].id;
    assert.equal((await request("DELETE", `/friends/${graceId}`, { token: ada.token })).status, 200);

    assert.deepEqual((await request("GET", "/friends", { token: ada.token })).body, []);
    assert.deepEqual((await request("GET", "/friends", { token: grace.token })).body, []);
    assert.equal((await request("DELETE", `/friends/${graceId}`, { token: ada.token })).status, 404);
});

test("user search reports the relationship and never leaks email", async () => {
    const ada = await signupAndLogin("searchada");
    const grace = await signupAndLogin("searchgrace");

    const before = await request("GET", `/users/search?q=${grace.username}`, { token: ada.token });
    assert.equal(before.status, 200);
    assert.equal(before.body.length, 1);
    assert.equal(before.body[0].relationship, "none");
    assert.equal(before.body[0].email, undefined);

    const sent = await request("POST", "/friends/requests", { token: ada.token, body: { username: grace.username } });
    assert.equal(
        (await request("GET", `/users/search?q=${grace.username}`, { token: ada.token })).body[0].relationship,
        "request_sent"
    );
    assert.equal(
        (await request("GET", `/users/search?q=${ada.username}`, { token: grace.token })).body[0].relationship,
        "request_received"
    );

    await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, { token: grace.token });
    assert.equal(
        (await request("GET", `/users/search?q=${grace.username}`, { token: ada.token })).body[0].relationship,
        "friends"
    );

    // Searching never returns the caller themselves, and an empty query is
    // an empty list rather than "everyone".
    const self = await request("GET", `/users/search?q=${ada.username}`, { token: ada.token });
    assert.deepEqual(self.body, []);
    assert.deepEqual((await request("GET", "/users/search?q=", { token: ada.token })).body, []);
});

test("LIKE wildcards in a search are matched literally", async () => {
    const ada = await signupAndLogin("wildcard");
    // "%" would otherwise match every username.
    assert.deepEqual((await request("GET", "/users/search?q=%25", { token: ada.token })).body, []);
    assert.deepEqual((await request("GET", "/users/search?q=_", { token: ada.token })).body, []);
});

test("friends endpoints require a session", async () => {
    for (const [method, urlPath] of [
        ["GET", "/friends"],
        ["GET", "/friends/requests"],
        ["POST", "/friends/requests"],
        ["GET", "/users/search?q=a"],
    ]) {
        assert.equal((await request(method, urlPath)).status, 401, `${method} ${urlPath}`);
    }
});
