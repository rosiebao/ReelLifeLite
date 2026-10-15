// Tests for /profile, /profile/photo, /profile-photos and /users/:id/profile
// (profile.js). Run with: npm test
//
// Same setup as auth.test.js: a throwaway database and media folder, set
// before ../app is required.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-profile-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-profile-media-"));

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
    db.close();
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
    const body_ = await res.json().catch(() => null);
    return { status: res.status, body: body_ };
}

async function signupAndLogin(username) {
    const email = `${username}@example.com`;
    const signup = await request("POST", "/signup", { body: { username, email, password: "password123" } });
    const login = await request("POST", "/login", { body: { email, password: "password123" } });
    return { id: signup.body.id, token: login.body.token };
}

// The smallest valid-looking files: the right first bytes plus some padding.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

test("a new profile has empty details and private defaults", async () => {
    const { token } = await signupAndLogin("fresh");
    const res = await request("GET", "/profile", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, "fresh");
    assert.equal(res.body.email, "fresh@example.com");
    assert.equal(res.body.first_name, "");
    assert.equal(res.body.bio, "");
    assert.equal(res.body.photo_url, null);
    assert.equal(res.body.profile_visibility, "friends");
    assert.equal(res.body.show_location, false);
    assert.equal(res.body.show_email, false);
    assert.ok(res.body.created_at);
    assert.equal(res.body.password_hash, undefined);
});

test("profile requires a login", async () => {
    assert.equal((await request("GET", "/profile")).status, 401);
    assert.equal((await request("PUT", "/profile", { body: { bio: "x" } })).status, 401);
});

test("PUT /profile saves the details and trims them", async () => {
    const { token } = await signupAndLogin("alexc");
    const res = await request("PUT", "/profile", {
        token,
        body: {
            first_name: "  Alex ",
            last_name: "Carter",
            location: "Seattle, WA",
            bio: "Collecting memories.",
            username: "alexcarter",
            email: "Alex.Carter@Example.com",
        },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.first_name, "Alex");
    assert.equal(res.body.username, "alexcarter");
    assert.equal(res.body.email, "alex.carter@example.com");
    assert.equal(res.body.location, "Seattle, WA");

    // The new email is the one to sign in with.
    const login = await request("POST", "/login", { body: { email: "alex.carter@example.com", password: "password123" } });
    assert.equal(login.status, 200);
});

test("PUT /profile only changes what is sent", async () => {
    const { token } = await signupAndLogin("partial");
    await request("PUT", "/profile", { token, body: { first_name: "Pat", bio: "Hello" } });
    const res = await request("PUT", "/profile", { token, body: { show_location: true } });
    assert.equal(res.body.first_name, "Pat");
    assert.equal(res.body.bio, "Hello");
    assert.equal(res.body.show_location, true);

    // Clearing a field with an empty string works too.
    const cleared = await request("PUT", "/profile", { token, body: { bio: "" } });
    assert.equal(cleared.body.bio, "");
});

test("PUT /profile rejects bad values", async () => {
    const { token } = await signupAndLogin("strict");
    await signupAndLogin("taken");
    const cases = [
        [{ username: "  " }, 400],
        [{ username: "taken" }, 409],
        [{ email: "taken@example.com" }, 409],
        [{ email: "no-at-sign" }, 400],
        [{ bio: "x".repeat(501) }, 400],
        [{ first_name: "x".repeat(51) }, 400],
        [{ profile_visibility: "everyone" }, 400],
        [{ show_email: "yes" }, 400],
    ];
    for (const [body, status] of cases) {
        assert.equal((await request("PUT", "/profile", { token, body })).status, status, JSON.stringify(body));
    }
    // Keeping your own username/email isn't a clash.
    const same = await request("PUT", "/profile", { token, body: { username: "strict", email: "strict@example.com" } });
    assert.equal(same.status, 200);
});

test("photo upload stores a PNG or JPG and replaces the old one", async () => {
    const { token } = await signupAndLogin("photogenic");
    const first = await request("PUT", "/profile/photo", {
        token,
        body: { filename: "me.png", data_base64: PNG.toString("base64") },
    });
    assert.equal(first.status, 200);
    assert.match(first.body.photo_url, /^\/profile-photos\/[a-f0-9]{32}\.png$/);

    const served = await fetch(`${baseUrl}${first.body.photo_url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");

    // A data: URL prefix is accepted as well.
    const second = await request("PUT", "/profile/photo", {
        token,
        body: { filename: "me.jpg", data_base64: `data:image/jpeg;base64,${JPG.toString("base64")}` },
    });
    assert.equal(second.status, 200);
    assert.match(second.body.photo_url, /\.jpg$/);
    // The first file is gone.
    assert.equal((await fetch(`${baseUrl}${first.body.photo_url}`)).status, 404);
});

test("photo upload rejects other file types, empty and oversized uploads", async () => {
    const { token } = await signupAndLogin("badphoto");
    const gif = await request("PUT", "/profile/photo", {
        token,
        body: { filename: "x.gif", data_base64: Buffer.from("GIF89a....").toString("base64") },
    });
    assert.equal(gif.status, 400);

    const empty = await request("PUT", "/profile/photo", { token, body: { filename: "x.png" } });
    assert.equal(empty.status, 400);

    // Just over 5 MB: within the 8 MB body limit, so profile.js turns it away.
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await request("PUT", "/profile/photo", {
        token,
        body: { filename: "big.png", data_base64: big.toString("base64") },
    });
    assert.equal(tooBig.status, 413);

    // Over the body limit itself: a 413 too, not a 500.
    const huge = await request("PUT", "/profile/photo", {
        token,
        body: { filename: "huge.png", data_base64: Buffer.alloc(7 * 1024 * 1024).toString("base64") },
    });
    assert.equal(huge.status, 413);
});

test("profile photos only serve names the server generated", async () => {
    assert.equal((await fetch(`${baseUrl}/profile-photos/..%2F..%2Fapp.db`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/profile-photos/${"a".repeat(32)}.png`)).status, 404);
});

test("other people see a profile only as far as its settings allow", async () => {
    const owner = await signupAndLogin("owner");
    const friend = await signupAndLogin("pal");
    const stranger = await signupAndLogin("stranger");
    await request("PUT", "/profile", { token: owner.token, body: { location: "Seattle", first_name: "Olive" } });

    const sent = await request("POST", "/friends/requests", { token: owner.token, body: { username: "pal" } });
    await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, { token: friend.token });

    // Friends-only by default: a stranger gets a 404, a friend gets it --
    // without the location or email, which are off by default.
    assert.equal((await request("GET", `/users/${owner.id}/profile`, { token: stranger.token })).status, 404);
    const asFriend = await request("GET", `/users/${owner.id}/profile`, { token: friend.token });
    assert.equal(asFriend.status, 200);
    assert.equal(asFriend.body.first_name, "Olive");
    assert.equal(asFriend.body.location, null);
    assert.equal(asFriend.body.email, null);

    await request("PUT", "/profile", {
        token: owner.token,
        body: { profile_visibility: "community", show_location: true, show_email: true },
    });
    const asStranger = await request("GET", `/users/${owner.id}/profile`, { token: stranger.token });
    assert.equal(asStranger.status, 200);
    assert.equal(asStranger.body.location, "Seattle");
    assert.equal(asStranger.body.email, "owner@example.com");
    // The settings themselves are only for the owner.
    assert.equal(asStranger.body.show_email, undefined);
});
