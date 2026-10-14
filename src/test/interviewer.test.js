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

    fakeClient.replies.push(
        "<title>The Girl Next Door</title>\n" +
            "<summary>How Mei moved in next door and changed everything.</summary>\n" +
            "<place>Seattle</place>\n<time_period>the summer of 1985</time_period>\n" +
            "<tags>Friendship, #Childhood, Friendship</tags>\n" +
            "<story>I met Mei when she moved in next door.\n\nWe were inseparable.</story>"
    );
    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, { token });
    assert.equal(drafted.status, 200);
    assert.equal(drafted.body.story, "I met Mei when she moved in next door.\n\nWe were inseparable.");
    assert.equal(drafted.body.title, "The Girl Next Door");
    assert.equal(drafted.body.summary, "How Mei moved in next door and changed everything.");
    assert.equal(drafted.body.place, "Seattle");
    assert.equal(drafted.body.time_period, "the summer of 1985");
    // No '#', no repeats -- the way the publish form stores tags.
    assert.deepEqual(drafted.body.tags, ["Friendship", "Childhood"]);
    assert.equal(drafted.body.ai, true);

    const storyRequest = fakeClient.requests.at(-1);
    assert.equal(storyRequest.output_config, undefined);
    const prompt = storyRequest.messages[0].content;
    assert.ok(prompt.includes("Interviewer: Who would you like to talk about?"));
    assert.ok(prompt.includes("Storyteller: She was my neighbour"));
    assert.ok(prompt.includes("Interviewer: How did you meet her?"));
    // Context the transcript alone doesn't carry: when it was recorded, and the topic.
    assert.match(prompt, /This interview was recorded on \w+day, \w+ \d{1,2}, \d{4}\./);
    assert.ok(prompt.includes(`Interview topic: ${interviewer.MODES.People.focus}`));
    assert.ok(storyRequest.system.includes("never invent"));
});

test("ending with an answer still in the box saves it and asks for no question", async () => {
    const token = await signupAndLogin("cora6", "cora6@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push("<title>Next Door</title><story>She was my neighbour.</story>");
    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, {
        token,
        body: { answer: "  She was my neighbour  " },
    });
    assert.equal(drafted.status, 200);
    assert.equal(fakeClient.requests.length, 1, "only the story is asked for -- no next question");
    assert.ok(fakeClient.requests[0].messages[0].content.includes("Storyteller: She was my neighbour"));

    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.deepEqual(
        prompts.map((prompt) => [prompt.content, prompt.response]),
        [["She was my neighbour", null]]
    );
});

test("the last answer is kept even when the story can't be written", async () => {
    const token = await signupAndLogin("cora7", "cora7@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push(new AnthropicBedrockMantle.InternalServerError(500, undefined, "boom", new Headers()));
    const res = await request("POST", `/conversations/${conversationId}/interview/story`, {
        token,
        body: { answer: "Don't lose this" },
    });
    assert.equal(res.status, 503);
    const prompts = (await request("GET", `/conversations/${conversationId}/prompts`, { token })).body;
    assert.equal(prompts.at(-1).content, "Don't lose this");
    assert.deepEqual((await request("GET", "/drafts", { token })).body, []);
});

test("a story cut off by max_tokens is an error, not a finished story", async () => {
    const token = await signupAndLogin("cora8", "cora8@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "<title>Half</title><story>It all began when" }],
    });
    const res = await request("POST", `/conversations/${conversationId}/interview/story`, {
        token,
        body: { answer: "A long one" },
    });
    assert.equal(res.status, 502);
    assert.deepEqual((await request("GET", "/drafts", { token })).body, []);
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

test("drafted details are trimmed to fit the publish form", async () => {
    const token = await signupAndLogin("cora9", "cora9@example.com");
    const conversationId = await startedInterview(token);

    const longTitle = "word ".repeat(60).trim(); // ~300 characters; titles allow 120
    const tags = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "x".repeat(41)].join(", ");
    fakeClient.replies.push(`<title>${longTitle}</title><tags>${tags}</tags><story>Short story.</story>`);
    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, {
        token,
        body: { answer: "Something" },
    });
    assert.equal(drafted.status, 200);
    assert.ok(drafted.body.title.length <= 120);
    assert.ok(drafted.body.title.endsWith("word"), "cut at a word break");
    assert.deepEqual(drafted.body.tags, ["One", "Two", "Three", "Four", "Five", "Six"]);
    assert.equal(drafted.body.place, "");

    // Publishing exactly what was drafted works.
    const published = await request("POST", "/stories", {
        token,
        body: {
            conversation_id: conversationId,
            title: drafted.body.title,
            content: drafted.body.story,
            tags: drafted.body.tags,
        },
    });
    assert.equal(published.status, 201);
});

test("History keeps the drafted details with the story", async () => {
    const token = await signupAndLogin("cora10", "cora10@example.com");
    const conversationId = await startedInterview(token);

    fakeClient.replies.push(
        "<title>Moving Day</title><summary>We left the farm.</summary><place>rural Ohio</place>" +
            "<time_period></time_period><tags>Family</tags><story>We left the farm in a borrowed truck.</story>"
    );
    const drafted = await request("POST", `/conversations/${conversationId}/interview/story`, {
        token,
        body: { answer: "We moved" },
    });
    const [draft] = (await request("GET", "/drafts", { token })).body;
    assert.equal(draft.draft_id, drafted.body.draft_id);
    assert.equal(draft.content, "We left the farm in a borrowed truck.");
    assert.equal(draft.title, "Moving Day");
    assert.equal(draft.summary, "We left the farm.");
    assert.equal(draft.place, "rural Ohio");
    assert.equal(draft.time_period, "");
    assert.deepEqual(draft.tags, ["Family"]);
});

test("parseStoryReply: missing details are blank, and a reply with no tags is all story", () => {
    assert.deepEqual(interviewer.parseStoryReply("<story>Just the story.</story>"), {
        title: "",
        summary: "",
        place: "",
        time_period: "",
        tags: [],
        story: "Just the story.",
    });
    const untagged = interviewer.parseStoryReply("I grew up by the river.\n\nIt flooded every spring.");
    assert.equal(untagged.story, "I grew up by the river.\n\nIt flooded every spring.");
    // Tags but no <story>: what's left outside the tags is the story.
    assert.equal(
        interviewer.parseStoryReply("<title>River</title>\nI grew up by the river.").story,
        "I grew up by the river."
    );
    assert.throws(() => interviewer.parseStoryReply("<title>Only a title</title>"), interviewer.InterviewerError);
    assert.throws(() => interviewer.parseStoryReply("<story>  </story>"), interviewer.InterviewerError);
});

