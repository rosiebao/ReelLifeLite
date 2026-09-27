// Tests for /signup /login /logout /whoami (auth.js). Run with: npm test
//
// node --test runs each test file in its own process, so setting
// DATABASE_PATH/MEDIA_ROOT here before requiring ../app gives this whole
// file an isolated, throwaway database -- nothing touches the real app.db.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-auth-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-auth-media-"));

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
    const body_ = await res.json().catch(() => null);
    return { status: res.status, body: body_ };
}

async function signupAndLogin(username, email, password = "password123") {
    await request("POST", "/signup", { body: { username, email, password } });
    return (await request("POST", "/login", { body: { email, password } })).body.token;
}

test("signup creates a user", async () => {
    const res = await request("POST", "/signup", {
        body: { username: "ada", email: "ada@example.com", password: "password123" },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
});

test("signup normalizes email case", async () => {
    await request("POST", "/signup", { body: { username: "ada2", email: "Ada2@Example.com", password: "password123" } });
    const res = await request("POST", "/login", { body: { email: "ada2@example.com", password: "password123" } });
    assert.equal(res.status, 200);
});

test("signup rejects duplicate email", async () => {
    await request("POST", "/signup", { body: { username: "dup1", email: "dup@example.com", password: "password123" } });
    const res = await request("POST", "/signup", { body: { username: "dup2", email: "dup@example.com", password: "password123" } });
    assert.equal(res.status, 409);
});

test("signup rejects duplicate username", async () => {
    await request("POST", "/signup", { body: { username: "sameuser", email: "one@example.com", password: "password123" } });
    const res = await request("POST", "/signup", { body: { username: "sameuser", email: "two@example.com", password: "password123" } });
    assert.equal(res.status, 409);
});

test("signup rejects empty username", async () => {
    const res = await request("POST", "/signup", { body: { username: "   ", email: "blank@example.com", password: "password123" } });
    assert.equal(res.status, 400);
});

test("signup rejects short password", async () => {
    const res = await request("POST", "/signup", { body: { username: "shortpw", email: "shortpw@example.com", password: "short" } });
    assert.equal(res.status, 400);
});

test("signup rejects invalid email", async () => {
    const res = await request("POST", "/signup", { body: { username: "bademail", email: "not-an-email", password: "password123" } });
    assert.equal(res.status, 400);
});

test("login rejects wrong password", async () => {
    await request("POST", "/signup", { body: { username: "bob", email: "bob@example.com", password: "password123" } });
    const res = await request("POST", "/login", { body: { email: "bob@example.com", password: "wrongpassword" } });
    assert.equal(res.status, 401);
});

test("login rejects unknown email", async () => {
    const res = await request("POST", "/login", { body: { email: "ghost@example.com", password: "password123" } });
    assert.equal(res.status, 401);
});

test("login invalidates previous session", async () => {
    await request("POST", "/signup", { body: { username: "grace", email: "grace@example.com", password: "password123" } });
    const oldToken = (await request("POST", "/login", { body: { email: "grace@example.com", password: "password123" } })).body.token;
    const newToken = (await request("POST", "/login", { body: { email: "grace@example.com", password: "password123" } })).body.token;
    assert.notEqual(oldToken, newToken);
    assert.equal((await request("GET", "/whoami", { token: oldToken })).status, 401);
    assert.equal((await request("GET", "/whoami", { token: newToken })).status, 200);
});

test("whoami returns user for valid token", async () => {
    const token = await signupAndLogin("whoamiuser", "whoami@example.com");
    const res = await request("GET", "/whoami", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, "whoamiuser");
    assert.equal(res.body.email, "whoami@example.com");
});

test("whoami rejects bad token", async () => {
    const res = await request("GET", "/whoami", { token: "not-a-real-token" });
    assert.equal(res.status, 401);
});

test("whoami without token returns 401", async () => {
    const res = await request("GET", "/whoami");
    assert.equal(res.status, 401);
});

test("logout invalidates token", async () => {
    const token = await signupAndLogin("logoutuser", "logout@example.com");
    assert.equal((await request("POST", "/logout", { token })).status, 200);
    assert.equal((await request("GET", "/whoami", { token })).status, 401);
});

test("expired session is rejected", async () => {
    const token = await signupAndLogin("expireduser", "expired@example.com");
    const past = new Date(Date.now() - 3600_000).toISOString();
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(past, token);
    const res = await request("GET", "/whoami", { token });
    assert.equal(res.status, 401);
});

test("unknown route returns 404", async () => {
    const res = await request("GET", "/does-not-exist");
    assert.equal(res.status, 404);
});
