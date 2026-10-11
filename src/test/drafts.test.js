// Tests for /drafts (drafts.js): every "Write my story" result is kept for the
// History tab. INTERVIEW_AI is unset, so a draft is just the answers joined.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-drafts-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-drafts-media-"));
delete process.env.INTERVIEW_AI;

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
    db.close(); // Windows won't delete a file that's still open
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

async function answeredInterview(token, answers, mode = "Moments") {
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    await request("POST", `/conversations/${conversationId}/interview/start`, { token, body: { mode } });
    for (const content of answers) {
        await request("POST", `/conversations/${conversationId}/interview/answer`, { token, body: { content } });
    }
    return conversationId;
}

function writeStory(token, conversationId) {
    return request("POST", `/conversations/${conversationId}/interview/story`, { token });
}

test("writing a story saves it to the history", async () => {
    const token = await signupAndLogin("dana1", "dana1@example.com");
    const conversationId = await answeredInterview(token, ["The day we moved."]);

    const written = await writeStory(token, conversationId);
    assert.equal(written.status, 200);
    assert.equal(typeof written.body.draft_id, "number");

    const drafts = (await request("GET", "/drafts", { token })).body;
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].draft_id, written.body.draft_id);
    assert.equal(drafts[0].conversation_id, conversationId);
    assert.equal(drafts[0].content, "The day we moved.");
    assert.equal(drafts[0].created_at, written.body.created_at);
    assert.equal(drafts[0].interview_mode, "Moments");
});

test("every draft is kept, newest first", async () => {
    const token = await signupAndLogin("dana2", "dana2@example.com");
    const first = await answeredInterview(token, ["One."]);
    const second = await answeredInterview(token, ["Two."], "People");

    const a = await writeStory(token, first);
    const b = await writeStory(token, second);
    const c = await writeStory(token, first);

    const ids = (await request("GET", "/drafts", { token })).body.map((draft) => draft.draft_id);
    assert.deepEqual(ids, [c.body.draft_id, b.body.draft_id, a.body.draft_id]);
});

test("a failed draft saves nothing", async () => {
    const token = await signupAndLogin("dana3", "dana3@example.com");
    const conversationId = await answeredInterview(token, []);
    assert.equal((await writeStory(token, conversationId)).status, 400);
    assert.deepEqual((await request("GET", "/drafts", { token })).body, []);
});

test("drafts are private to their author", async () => {
    const owner = await signupAndLogin("dana4", "dana4@example.com");
    const other = await signupAndLogin("dana5", "dana5@example.com");
    const written = await writeStory(owner, await answeredInterview(owner, ["Mine."]));

    assert.deepEqual((await request("GET", "/drafts", { token: other })).body, []);
    const res = await request("DELETE", `/drafts/${written.body.draft_id}`, { token: other });
    assert.equal(res.status, 404);
    assert.equal((await request("GET", "/drafts", { token: owner })).body.length, 1);
});

test("deleting a draft removes it from the history", async () => {
    const token = await signupAndLogin("dana6", "dana6@example.com");
    const written = await writeStory(token, await answeredInterview(token, ["Gone soon."]));

    const res = await request("DELETE", `/drafts/${written.body.draft_id}`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual((await request("GET", "/drafts", { token })).body, []);
    assert.equal((await request("DELETE", `/drafts/${written.body.draft_id}`, { token })).status, 404);
});

test("drafts require auth", async () => {
    assert.equal((await request("GET", "/drafts")).status, 401);
    assert.equal((await request("DELETE", "/drafts/1")).status, 401);
});
