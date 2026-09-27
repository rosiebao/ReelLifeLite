// Tests for /family (family.js). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-family-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-family-media-"));

const app = require("../app");
const { db } = require("../db");

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

async function signupAndLogin(username, email, password = "password123") {
    await request("POST", "/signup", { body: { username, email, password } });
    return (await request("POST", "/login", { body: { email, password } })).body.token;
}

function tree(...rows) {
    return {
        rows: rows.map((names) => ({
            members: names.map((name) => ({ name, photo: "profile.jpg", is_self: false })),
        })),
    };
}

// What a GET/PUT returns for a tree that has been saved at least once.
function saved(...rows) {
    return { ...tree(...rows), seeded: true };
}

test("family tree requires a session", async () => {
    assert.equal((await request("GET", "/family")).status, 401);
    assert.equal((await request("PUT", "/family", { body: tree(["Mom"]) })).status, 401);
});

test("a new user starts with an empty, unseeded tree", async () => {
    const token = await signupAndLogin("newcomer", "newcomer@example.com");
    const got = await request("GET", "/family", { token });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { rows: [], seeded: false });
});

test("saved tree comes back on the next fetch", async () => {
    const token = await signupAndLogin("ada", "ada@example.com");
    const mine = tree(["Grandma", "Grandpa"], ["Mom", "Dad"], ["Me"]);

    const put = await request("PUT", "/family", { token, body: mine });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, saved(["Grandma", "Grandpa"], ["Mom", "Dad"], ["Me"]));
    assert.deepEqual((await request("GET", "/family", { token })).body, put.body);
});

// The page uses `seeded` to decide whether to apply the starting layout from
// index.html. Without it, deleting every row would look like a new account and
// the default tree would come back and overwrite the deletion.
test("an emptied tree stays empty instead of being reseeded", async () => {
    const token = await signupAndLogin("cleared", "cleared@example.com");
    await request("PUT", "/family", { token, body: tree(["Grandma"], ["Mom"], ["Me"]) });

    const emptied = await request("PUT", "/family", { token, body: { rows: [] } });
    assert.deepEqual(emptied.body, { rows: [], seeded: true });

    // Still empty, and still flagged as seeded, on every later fetch.
    assert.deepEqual((await request("GET", "/family", { token })).body, { rows: [], seeded: true });
    assert.deepEqual((await request("GET", "/family", { token })).body, { rows: [], seeded: true });
});

test("seeded is per user", async () => {
    const one = await signupAndLogin("seeded1", "seeded1@example.com");
    const two = await signupAndLogin("seeded2", "seeded2@example.com");

    await request("PUT", "/family", { token: one, body: { rows: [] } });
    assert.equal((await request("GET", "/family", { token: one })).body.seeded, true);
    assert.equal((await request("GET", "/family", { token: two })).body.seeded, false);
});

test("a tree belongs only to the user who saved it", async () => {
    const ada = await signupAndLogin("ada2", "ada2@example.com");
    const grace = await signupAndLogin("grace", "grace@example.com");

    await request("PUT", "/family", { token: ada, body: tree(["Ada's mom"]) });
    assert.deepEqual((await request("GET", "/family", { token: grace })).body, { rows: [], seeded: false });

    await request("PUT", "/family", { token: grace, body: tree(["Grace's mom"]) });
    assert.deepEqual((await request("GET", "/family", { token: ada })).body, saved(["Ada's mom"]));
    assert.deepEqual((await request("GET", "/family", { token: grace })).body, saved(["Grace's mom"]));
});

test("saving replaces rows and members, including removals", async () => {
    const token = await signupAndLogin("edith", "edith@example.com");
    await request("PUT", "/family", { token, body: tree(["A", "B", "C"], ["D", "E"], ["F"]) });

    const shrunk = tree(["A", "B"], ["D"]);
    assert.deepEqual((await request("PUT", "/family", { token, body: shrunk })).body, saved(["A", "B"], ["D"]));
    assert.deepEqual((await request("GET", "/family", { token })).body, saved(["A", "B"], ["D"]));

    assert.deepEqual((await request("PUT", "/family", { token, body: { rows: [] } })).body, {
        rows: [],
        seeded: true,
    });
});

test("members that did not move keep their member_id across a save", async () => {
    const token = await signupAndLogin("stable", "stable@example.com");
    await request("PUT", "/family", { token, body: tree(["Grandma", "Grandpa"], ["Mom"]) });

    const idOf = (name) => db.prepare("SELECT member_id FROM family_members WHERE name = ?").get(name)?.member_id;
    const grandmaId = idOf("Grandma");

    // Rename someone else and add a member elsewhere.
    await request("PUT", "/family", { token, body: tree(["Grandma", "Grandfather"], ["Mom", "Dad"]) });
    assert.equal(idOf("Grandma"), grandmaId);
});

test("deleting rows cleans up their members", async () => {
    const token = await signupAndLogin("tidy", "tidy@example.com");
    await request("PUT", "/family", { token, body: tree(["Keep"], ["Drop1", "Drop2"]) });
    await request("PUT", "/family", { token, body: tree(["Keep"]) });

    const orphans = db
        .prepare("SELECT COUNT(*) AS n FROM family_members WHERE name IN ('Drop1', 'Drop2')")
        .get();
    assert.equal(orphans.n, 0);
});

test("blank names fall back to Unnamed", async () => {
    const token = await signupAndLogin("blank", "blank@example.com");
    const put = await request("PUT", "/family", { token, body: { rows: [{ members: [{ name: "   " }] }] } });
    assert.deepEqual(put.body, saved(["Unnamed"]));
});

test("the is_self flag round-trips", async () => {
    const token = await signupAndLogin("selfflag", "selfflag@example.com");
    const body = {
        rows: [
            { members: [{ name: "Mom" }, { name: "Dad" }] },
            { members: [{ name: "Me", is_self: true }, { name: "Sister" }] },
        ],
    };

    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 200);

    const got = (await request("GET", "/family", { token })).body;
    assert.deepEqual(got.rows[1].members.map((m) => [m.name, m.is_self]), [
        ["Me", true],
        ["Sister", false],
    ]);
    assert.deepEqual(got.rows[0].members.map((m) => m.is_self), [false, false]);
});

test("the is_self flag survives edits elsewhere in the tree", async () => {
    const token = await signupAndLogin("selfstays", "selfstays@example.com");
    await request("PUT", "/family", {
        token,
        body: { rows: [{ members: [{ name: "Me", is_self: true }, { name: "Sister" }] }] },
    });

    // Remove the sibling; "Me" shifts position but stays flagged.
    const put = await request("PUT", "/family", {
        token,
        body: { rows: [{ members: [{ name: "Me", is_self: true }] }] },
    });
    assert.deepEqual(put.body.rows[0].members, [{ name: "Me", photo: "profile.jpg", is_self: true }]);
});

test("a tree can only mark one member as you", async () => {
    const token = await signupAndLogin("twoselves", "twoselves@example.com");
    const body = {
        rows: [{ members: [{ name: "Me", is_self: true }, { name: "Also me", is_self: true }] }],
    };

    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 400);
    assert.match(put.body.error, /one family member/i);
});

test("malformed or oversized trees are rejected", async () => {
    const token = await signupAndLogin("bad", "bad@example.com");

    assert.equal((await request("PUT", "/family", { token, body: {} })).status, 400);
    assert.equal((await request("PUT", "/family", { token, body: { rows: "nope" } })).status, 400);
    assert.equal((await request("PUT", "/family", { token, body: { rows: [{}] } })).status, 400);

    const tooManyRows = { rows: Array.from({ length: 21 }, () => ({ members: [] })) };
    assert.equal((await request("PUT", "/family", { token, body: tooManyRows })).status, 400);

    const tooLongName = { rows: [{ members: [{ name: "x".repeat(101) }] }] };
    assert.equal((await request("PUT", "/family", { token, body: tooLongName })).status, 400);
});

test("a rejected save leaves the stored tree untouched", async () => {
    const token = await signupAndLogin("intact", "intact@example.com");
    await request("PUT", "/family", { token, body: tree(["Mom", "Dad"]) });

    await request("PUT", "/family", { token, body: { rows: [{ members: [{ name: "x".repeat(101) }] }] } });
    assert.deepEqual((await request("GET", "/family", { token })).body, saved(["Mom", "Dad"]));
});
