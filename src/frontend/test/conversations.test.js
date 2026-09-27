// Tests for /conversations and /prompts (conversations.js). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-conversations-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-conversations-media-"));

const app = require("../app");
const { db } = require("../db");
const { saveMedia } = require("../storage");

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

test("create conversation creates row and transcript file", async () => {
    const token = await signupAndLogin("ada", "ada@example.com");
    const created = await request("POST", "/conversations", { token });
    assert.equal(created.status, 201);

    const conv = await request("GET", `/conversations/${created.body.conversation_id}`, { token });
    assert.equal(conv.status, 200);
    assert.equal(conv.body.cost, 0);
    assert.ok(conv.body.creation_date);
    assert.ok(fs.existsSync(conv.body.conversation));
    assert.equal(fs.readFileSync(conv.body.conversation, "utf8"), "");
});

test("add prompt creates row and appends transcript", async () => {
    const token = await signupAndLogin("ada2", "ada2@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;

    const added = await request("POST", `/conversations/${conversationId}/prompts`, {
        token,
        body: { content: "Hello AI" },
    });
    assert.equal(added.status, 201);

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].content, "Hello AI");
    assert.equal(prompts[0].response, null);
    assert.equal(prompts[0].input_media, null);

    const conv = (await request("GET", `/conversations/${conversationId}`, { token })).body;
    assert.ok(fs.readFileSync(conv.conversation, "utf8").includes("USER: Hello AI"));
});

test("add prompt rejects empty content", async () => {
    const token = await signupAndLogin("ada3", "ada3@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const res = await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content: "" } });
    assert.equal(res.status, 400);
});

test("add prompt rejects unknown conversation", async () => {
    const token = await signupAndLogin("ada4", "ada4@example.com");
    const res = await request("POST", "/conversations/999999/prompts", { token, body: { content: "hi" } });
    assert.equal(res.status, 404);
});

test("add prompt saves input media and sanitizes filename", async () => {
    const token = await signupAndLogin("ada5", "ada5@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;

    const data = Buffer.from("raw file bytes").toString("base64");
    const res = await request("POST", `/conversations/${conversationId}/prompts`, {
        token,
        body: { content: "see attached", input_media_filename: "../../evil.txt", input_media_base64: data },
    });
    assert.equal(res.status, 201);

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    const mediaPath = prompts[0].input_media;
    assert.ok(fs.existsSync(mediaPath));
    assert.equal(fs.readFileSync(mediaPath, "utf8"), "raw file bytes");
    assert.ok(!mediaPath.split(path.sep).includes(".."));
});

test("add response updates prompt and accumulates cost", async () => {
    const token = await signupAndLogin("ada6", "ada6@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;

    const p1 = (await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content: "Q1" } })).body
        .prompt_id;
    await request("POST", `/prompts/${p1}/response`, { token, body: { response: "A1", cost: 0.05 } });
    const p2 = (await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content: "Q2" } })).body
        .prompt_id;
    await request("POST", `/prompts/${p2}/response`, { token, body: { response: "A2", cost: 0.02 } });

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts[0].response, "A1");

    const conv = (await request("GET", `/conversations/${conversationId}`, { token })).body;
    assert.ok(Math.abs(conv.cost - 0.07) < 1e-9);
});

test("add response rejects unknown prompt", async () => {
    const token = await signupAndLogin("ada7", "ada7@example.com");
    const res = await request("POST", "/prompts/999999/response", { token, body: { response: "hi" } });
    assert.equal(res.status, 404);
});

test("add response rejects empty response", async () => {
    const token = await signupAndLogin("ada8", "ada8@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const promptId = (await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content: "Q" } }))
        .body.prompt_id;
    const res = await request("POST", `/prompts/${promptId}/response`, { token, body: { response: "" } });
    assert.equal(res.status, 400);
});

test("get conversation not found", async () => {
    const token = await signupAndLogin("ada9", "ada9@example.com");
    const res = await request("GET", "/conversations/999999", { token });
    assert.equal(res.status, 404);
});

test("get prompts ordered by time", async () => {
    const token = await signupAndLogin("ada10", "ada10@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    for (const content of ["first", "second", "third"]) {
        await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content } });
    }
    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.deepEqual(
        prompts.map((p) => p.content),
        ["first", "second", "third"]
    );
});

test("list conversations scoped to user", async () => {
    const token = await signupAndLogin("owner", "owner@example.com");
    const otherToken = await signupAndLogin("other", "other@example.com");

    const a = (await request("POST", "/conversations", { token })).body.conversation_id;
    const b = (await request("POST", "/conversations", { token })).body.conversation_id;
    await request("POST", "/conversations", { token: otherToken });

    const conversations = (await request("GET", "/conversations", { token })).body;
    const ids = new Set(conversations.map((c) => c.conversation_id));
    assert.deepEqual(ids, new Set([a, b]));
});

test("requires authentication", async () => {
    const res = await request("GET", "/conversations");
    assert.equal(res.status, 401);
});

test("cannot access another user's conversation", async () => {
    const token = await signupAndLogin("mine", "mine@example.com");
    const otherToken = await signupAndLogin("notmine", "notmine@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const res = await request("GET", `/conversations/${conversationId}`, { token: otherToken });
    assert.equal(res.status, 404);
});

test("prompt with base64 media round-trips", async () => {
    const token = await signupAndLogin("mediauser", "mediauser@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const payload = Buffer.from("hello from a file").toString("base64");
    await request("POST", `/conversations/${conversationId}/prompts`, {
        token,
        body: { content: "here's a file", input_media_filename: "note.txt", input_media_base64: payload },
    });
    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(fs.readFileSync(prompts[0].input_media, "utf8"), "hello from a file");
});

test("a plain conversation is a chat with no interview number", async () => {
    const token = await signupAndLogin("chatkind", "chatkind@example.com");
    const created = await request("POST", "/conversations", { token });
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, "chat");
    assert.equal(created.body.interview_number, null);

    const conv = (await request("GET", `/conversations/${created.body.conversation_id}`, { token })).body;
    assert.equal(conv.kind, "chat");
    assert.equal(conv.interview_number, null);
});

test("interviews are numbered per user and keep their mode and method", async () => {
    const token = await signupAndLogin("interviewer", "interviewer@example.com");
    const otherToken = await signupAndLogin("interviewer2", "interviewer2@example.com");
    const body = { kind: "interview", mode: "Journey", method: "text" };

    const first = (await request("POST", "/conversations", { token, body })).body;
    // A chat in between must not use up an interview number.
    await request("POST", "/conversations", { token });
    const second = (await request("POST", "/conversations", { token, body: { kind: "interview" } })).body;
    const othersFirst = (await request("POST", "/conversations", { token: otherToken, body })).body;

    assert.equal(first.interview_number, 1);
    assert.equal(second.interview_number, 2);
    assert.equal(othersFirst.interview_number, 1);

    const conv = (await request("GET", `/conversations/${first.conversation_id}`, { token })).body;
    assert.equal(conv.kind, "interview");
    assert.equal(conv.interview_mode, "Journey");
    assert.equal(conv.interview_method, "text");

    const listed = (await request("GET", "/conversations", { token })).body;
    assert.deepEqual(
        listed.filter((c) => c.kind === "interview").map((c) => c.interview_number),
        [1, 2]
    );
});

test("an interview's saved turns can be read back to resume it", async () => {
    const token = await signupAndLogin("resumer", "resumer@example.com");
    const { conversation_id } = (
        await request("POST", "/conversations", { token, body: { kind: "interview", mode: "Wisdom" } })
    ).body;

    for (const [question, answer] of [
        ["Where did you grow up?", "In Chengdu."],
        ["What was your home like?", "Small, near the river."],
    ]) {
        const { prompt_id } = (
            await request("POST", `/conversations/${conversation_id}/prompts`, { token, body: { content: answer } })
        ).body;
        await request("POST", `/prompts/${prompt_id}/response`, { token, body: { response: question } });
    }

    const prompts = (await request("GET", `/conversations/${conversation_id}/prompts`, { token })).body;
    assert.deepEqual(
        prompts.map((p) => [p.response, p.content]),
        [
            ["Where did you grow up?", "In Chengdu."],
            ["What was your home like?", "Small, near the river."],
        ]
    );
});

test("unknown conversation kinds and oversized interview fields are rejected", async () => {
    const token = await signupAndLogin("badkind", "badkind@example.com");
    const badKind = await request("POST", "/conversations", { token, body: { kind: "podcast" } });
    assert.equal(badKind.status, 400);

    const longMode = await request("POST", "/conversations", {
        token,
        body: { kind: "interview", mode: "x".repeat(51) },
    });
    assert.equal(longMode.status, 400);
});

test("foreign key is enforced at the DB level", () => {
    assert.throws(() => {
        db.prepare(
            "INSERT INTO prompts (conversation_id, prompt_time, content, response, input_media, output_media) VALUES (999999, ?, 'orphan', NULL, NULL, NULL)"
        ).run(new Date().toISOString());
    });
});

test("saveMedia is exported and usable directly", () => {
    const p = saveMedia(1, "x.txt", Buffer.from("hi").toString("base64"));
    assert.equal(fs.readFileSync(p, "utf8"), "hi");
});
