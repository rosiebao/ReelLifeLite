// Tests for the Claude (Bedrock) code path in interviewer.js, through the
// interview routes. A stand-in client records each request and returns canned
// Messages API responses, so nothing leaves the machine. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-interviewer-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-interviewer-media-"));

const app = require("../app");
const { db } = require("../db");
const interviewer = require("../interviewer");

// Each call takes the next scripted reply: a string becomes a text response,
// an Error is thrown, and anything else is returned as the whole response.
const fakeClient = {
    requests: [],
    replies: [],
    messages: {
        async create(params) {
            fakeClient.requests.push(params);
            const reply = fakeClient.replies.shift();
            if (reply instanceof Error) throw reply;
            if (typeof reply === "string") {
                return { stop_reason: "end_turn", content: [{ type: "text", text: reply }] };
            }
            return reply;
        },
    },
};

let server;
let baseUrl;

test.before(async () => {
    interviewer.setClientForTests(fakeClient);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    interviewer.setClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    db.close(); // Windows won't delete a file that's still open
    fs.rmSync(process.env.DATABASE_PATH, { force: true });
    fs.rmSync(process.env.MEDIA_ROOT, { recursive: true, force: true });
});

test.beforeEach(() => {
    fakeClient.requests = [];
    fakeClient.replies = [];
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

async function startedInterview(token, opening = "Who would you like to talk about?") {
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    fakeClient.replies.push(opening);
    await request("POST", `/conversations/${conversationId}/interview/start`, { token, body: { mode: "People" } });
    fakeClient.requests = [];
    return conversationId;
}

test("questions come from Claude with the interview so far", async () => {
    const token = await signupAndLogin("cora", "cora@example.com");
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;

    fakeClient.replies.push("Who would you like to talk about?");
    const started = await request("POST", `/conversations/${conversationId}/interview/start`, {
        token,
        body: { mode: "People" },
    });
    assert.equal(started.body.question, "Who would you like to talk about?");

    const [opening] = fakeClient.requests;
    assert.equal(opening.model, "anthropic.claude-opus-5");
    assert.deepEqual(opening.output_config, { effort: "low" });
    assert.ok(opening.system.includes(interviewer.MODES.People.focus));
    // Sampling parameters are rejected by current models; ReelLife sent them.
    assert.equal(opening.temperature, undefined);
    assert.equal(opening.top_p, undefined);
    assert.deepEqual(
        opening.messages.map((message) => message.role),
        ["user"]
    );

    fakeClient.replies.push("How did you meet her?");
    const answered = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "My grandmother Mei" },
    });
    assert.equal(answered.body.question, "How did you meet her?");
    assert.deepEqual(fakeClient.requests[1].messages.slice(1), [
        { role: "assistant", content: "Who would you like to talk about?" },
        { role: "user", content: "My grandmother Mei" },
    ]);
});

test("a refusal is a 502 that keeps the answer, and skip retries it", async () => {
    const token = await signupAndLogin("cora2", "cora2@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push({ stop_reason: "refusal", content: [] });
    const failed = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "She raised me" },
    });
    assert.equal(failed.status, 502);

    let prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].content, "She raised me");
    assert.equal(prompts[0].response, null);

    fakeClient.replies.push("What was a normal day with her like?");
    const retried = await request("POST", `/conversations/${conversationId}/interview/skip`, { token });
    assert.equal(retried.status, 200);
    prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts[0].response, "What was a normal day with her like?");
    // A retry asks for the next question, not a replacement for a skipped one.
    assert.equal(fakeClient.requests.at(-1).messages.at(-1).content, "She raised me");
});

test("skip asks Claude for a different question", async () => {
    const token = await signupAndLogin("cora3", "cora3@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push("Who else was in the family?");
    const skipped = await request("POST", `/conversations/${conversationId}/interview/skip`, { token });
    assert.equal(skipped.body.question, "Who else was in the family?");

    const { messages } = fakeClient.requests[0];
    assert.equal(messages.at(-2).content, "Who would you like to talk about?");
    assert.equal(messages.at(-1).role, "user");
});

test("rate limits come back as 503", async () => {
    const token = await signupAndLogin("cora4", "cora4@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push(new AnthropicBedrockMantle.RateLimitError(429, undefined, "slow down", new Headers()));
    const res = await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "Hello" },
    });
    assert.equal(res.status, 503);
});

test("the story is written from the transcript", async () => {
    const token = await signupAndLogin("cora5", "cora5@example.com");
    const conversationId = await startedInterview(token);
    fakeClient.replies.push("How did you meet her?");
    await request("POST", `/conversations/${conversationId}/interview/answer`, {
        token,
        body: { content: "She was my neighbour" },
    });

    fakeClient.replies.push("I met Mei when she moved in next door.");
    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, { token });
    assert.equal(drafted.body.story, "I met Mei when she moved in next door.");

    const storyRequest = fakeClient.requests.at(-1);
    assert.equal(storyRequest.output_config, undefined);
    const prompt = storyRequest.messages[0].content;
    assert.ok(prompt.includes("Interviewer: Who would you like to talk about?"));
    assert.ok(prompt.includes("Storyteller: She was my neighbour"));
    assert.ok(prompt.includes("Interviewer: How did you meet her?"));
});

test("interviewMessages leaves an unanswered turn as back-to-back answers", () => {
    const messages = interviewer.interviewMessages("Opening?", [
        { content: "one", response: null },
        { content: "two", response: "Next?" },
    ]);
    assert.deepEqual(
        messages.map((message) => `${message.role}:${message.content}`),
        [
            "user:Please ask me the first question to begin my story.",
            "assistant:Opening?",
            "user:one",
            "user:two",
            "assistant:Next?",
        ]
    );
});
