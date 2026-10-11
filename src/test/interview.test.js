// Tests for /conversations/{id}/interview/* (interview.js) without Claude --
// INTERVIEW_AI is unset, so the interviewer uses its canned questions. The
// Bedrock code path is covered in interviewer.test.js. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-interview-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-interview-media-"));
delete process.env.INTERVIEW_AI;

const app = require("../app");
const { db } = require("../db");
const { MODES } = require("../interviewer");

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

async function newInterview(token, mode = "People") {
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const started = await request("POST", `/conversations/${conversationId}/interview/start`, {
        token,
        body: { mode },
    });
    return { conversationId, started };
}

test("start asks the mode's opening question and records the mode", async () => {
    const token = await signupAndLogin("iris", "iris@example.com");
    const { conversationId, started } = await newInterview(token, "Lessons");
    assert.equal(started.status, 201);
    assert.deepEqual(started.body, { mode: "Lessons", question: MODES.Lessons.opening });

    const conversation = (await request("GET", `/conversations/${conversationId}`, { token })).body;
    assert.equal(conversation.interview_mode, "Lessons");
    assert.equal(conversation.opening_question, MODES.Lessons.opening);
    assert.ok(fs.readFileSync(conversation.conversation, "utf8").includes(`AI: ${MODES.Lessons.opening}`));
});

test("starting again returns the question already asked", async () => {
    const token = await signupAndLogin("iris2", "iris2@example.com");
    const { conversationId, started } = await newInterview(token);
    const again = await request("POST", `/conversations/${conversationId}/interview/start`, {
        token,
        body: { mode: "Moments" },
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, started.body);
});

test("start rejects an unknown mode", async () => {
    const token = await signupAndLogin("iris3", "iris3@example.com");
    const { started } = await newInterview(token, "Life Period");
    assert.equal(started.status, 400);
});

test("start refuses a conversation that already has messages", async () => {
    const token = await signupAndLogin("iris4", "iris4@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content: "hi" } });
    const res = await request("POST", `/conversations/${conversationId}/interview/start`, { token, body: {} });
    assert.equal(res.status, 409);
});

test("answer saves the answer with the next question as its response", async () => {
    const token = await signupAndLogin("iris5", "iris5@example.com");
    const { conversationId } = await newInterview(token);

    const answered = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "  My grandmother Mei  " },
    });
    assert.equal(answered.status, 201);
    assert.ok(answered.body.question);

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].prompt_id, answered.body.prompt_id);
    assert.equal(prompts[0].content, "My grandmother Mei");
    assert.equal(prompts[0].response, answered.body.question);
});

test("answer rejects an empty answer", async () => {
    const token = await signupAndLogin("iris6", "iris6@example.com");
    const { conversationId } = await newInterview(token);
    const res = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "   " },
    });
    assert.equal(res.status, 400);
});

test("skip replaces the opening question before any answer", async () => {
    const token = await signupAndLogin("iris7", "iris7@example.com");
    const { conversationId, started } = await newInterview(token);

    const skipped = await request("POST", `/conversations/${conversationId}/interview/skip`, { token });
    assert.equal(skipped.status, 200);
    assert.notEqual(skipped.body.question, started.body.question);

    const conversation = (await request("GET", `/conversations/${conversationId}`, { token })).body;
    assert.equal(conversation.opening_question, skipped.body.question);
});

test("skip replaces the latest question after an answer", async () => {
    const token = await signupAndLogin("iris8", "iris8@example.com");
    const { conversationId } = await newInterview(token);
    const answered = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "We lived by the river" },
    });

    const skipped = await request("POST", `/conversations/${conversationId}/interview/skip`, { token });
    assert.equal(skipped.status, 200);
    assert.notEqual(skipped.body.question, answered.body.question);

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].response, skipped.body.question);
});

test("skip needs a started interview", async () => {
    const token = await signupAndLogin("iris9", "iris9@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    const res = await request("POST", `/conversations/${conversationId}/interview/skip`, { token });
    assert.equal(res.status, 409);
});

test("story drafts from the answers only", async () => {
    const token = await signupAndLogin("iris10", "iris10@example.com");
    const { conversationId } = await newInterview(token);
    for (const content of ["First memory.", "Second memory."]) {
        await request("POST", `/conversations/${conversationId}/interview/answer`, { token, body: { content } });
    }

    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, { token });
    assert.equal(drafted.status, 200);
    assert.equal(drafted.body.story, "First memory.\n\nSecond memory.");
});

test("story needs at least one answer", async () => {
    const token = await signupAndLogin("iris11", "iris11@example.com");
    const { conversationId } = await newInterview(token);
    const res = await request("POST", `/conversations/${conversationId}/interview/story`, { token });
    assert.equal(res.status, 400);
});

test("interview routes 404 on another user's conversation", async () => {
    const owner = await signupAndLogin("iris12", "iris12@example.com");
    const other = await signupAndLogin("iris13", "iris13@example.com");
    const { conversationId } = await newInterview(owner);

    for (const action of ["start", "answer", "skip", "story"]) {
        const res = await request("POST", `/conversations/${conversationId}/interview/${action}`, {
            token: other,
            body: { content: "hi", mode: "People" },
        });
        assert.equal(res.status, 404, action);
    }
});

test("interview routes require auth", async () => {
    const res = await request("POST", "/conversations/1/interview/start", { body: {} });
    assert.equal(res.status, 401);
});
