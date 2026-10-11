// Tests for /stories (stories.js) -- publishing a conversation and who gets to
// read it afterwards. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-stories-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-stories-media-"));

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
    // 204 (an unpublished conversation) has no body to parse.
    const parsed = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body: parsed };
}

// A fresh account per call: "one active session per user" means reusing a
// login across tests would invalidate the earlier token.
let userCounter = 0;
async function signupAndLogin(prefix, password = "password123") {
    const username = `${prefix}${userCounter++}`;
    const email = `${username}@example.com`;
    await request("POST", "/signup", { body: { username, email, password } });
    const token = (await request("POST", "/login", { body: { email, password } })).body.token;
    return { username, email, token };
}

// A conversation with `messages` said into it, which is what publishing turns
// into a story.
async function conversationWith(token, messages) {
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    for (const content of messages) {
        const { body } = await request("POST", `/conversations/${conversationId}/prompts`, {
            token,
            body: { content },
        });
        await request("POST", `/prompts/${body.prompt_id}/response`, { token, body: { response: "And then?" } });
    }
    return conversationId;
}

async function befriend(a, b) {
    const sent = await request("POST", "/friends/requests", { token: a.token, body: { username: b.username } });
    await request("POST", `/friends/requests/${sent.body.friendship_id}/accept`, { token: b.token });
}

test("publishing stores the author's own messages as the story content", async () => {
    const ada = await signupAndLogin("author");
    const conversationId = await conversationWith(ada.token, ["We left at dawn.", "The boat was full."]);

    const published = await request("POST", "/stories", {
        token: ada.token,
        body: {
            conversation_id: conversationId,
            title: "Leaving home",
            summary: "The morning we left.",
            tags: ["#Family", "Travel"],
            place: "Guangzhou",
            time_period: "1950s",
            visibility: "public",
        },
    });

    assert.equal(published.status, 201);
    assert.equal(published.body.title, "Leaving home");
    assert.equal(published.body.author, ada.username);
    assert.equal(published.body.conversation_id, conversationId);
    assert.equal(published.body.visibility, "public");
    assert.equal(published.body.place, "Guangzhou");
    // The canned assistant replies are interview prompts, not the story.
    assert.equal(published.body.content, "We left at dawn.\n\nThe boat was full.");
    assert.ok(!published.body.content.includes("And then?"));
    // The leading '#' is stripped so the UI can add its own.
    assert.deepEqual(published.body.tags, ["Family", "Travel"]);
});

test("the author can send their own edited text instead", async () => {
    const ada = await signupAndLogin("editor");
    const conversationId = await conversationWith(ada.token, ["rough notes"]);

    const published = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Polished", content: "A tidied up version." },
    });
    assert.equal(published.body.content, "A tidied up version.");
});

test("publishing needs a title and something to publish", async () => {
    const ada = await signupAndLogin("empty");
    const emptyConversation = (await request("POST", "/conversations", { token: ada.token })).body.conversation_id;

    assert.equal(
        (await request("POST", "/stories", { token: ada.token, body: { conversation_id: emptyConversation } })).status,
        400
    );
    // A conversation with no messages has no content to snapshot.
    const noContent = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: emptyConversation, title: "Nothing yet" },
    });
    assert.equal(noContent.status, 400);
});

test("you can only publish your own conversation", async () => {
    const ada = await signupAndLogin("owner");
    const mallory = await signupAndLogin("stranger");
    const conversationId = await conversationWith(ada.token, ["mine"]);

    const stolen = await request("POST", "/stories", {
        token: mallory.token,
        body: { conversation_id: conversationId, title: "Not mine" },
    });
    assert.equal(stolen.status, 404);
});

test("publishing the same conversation twice edits the story", async () => {
    const ada = await signupAndLogin("republisher");
    const conversationId = await conversationWith(ada.token, ["first pass"]);

    const first = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Draft", visibility: "private" },
    });
    assert.equal(first.status, 201);

    const second = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Final", visibility: "public" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.story_id, first.body.story_id);
    assert.equal(second.body.title, "Final");

    const mine = await request("GET", "/stories/mine", { token: ada.token });
    assert.equal(mine.body.length, 1);
});

test("visibility decides who can read a story", async () => {
    const ada = await signupAndLogin("teller");
    const friend = await signupAndLogin("friend");
    const stranger = await signupAndLogin("outsider");
    await befriend(ada, friend);

    const ids = {};
    for (const visibility of ["private", "friends", "public"]) {
        const conversationId = await conversationWith(ada.token, [`a ${visibility} memory`]);
        const published = await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: `${visibility} story`, visibility },
        });
        ids[visibility] = published.body.story_id;
    }

    // The author reads all three.
    for (const visibility of ["private", "friends", "public"]) {
        assert.equal((await request("GET", `/stories/${ids[visibility]}`, { token: ada.token })).status, 200);
    }

    // A friend gets the friends and public ones, never the private one.
    assert.equal((await request("GET", `/stories/${ids.private}`, { token: friend.token })).status, 404);
    assert.equal((await request("GET", `/stories/${ids.friends}`, { token: friend.token })).status, 200);
    assert.equal((await request("GET", `/stories/${ids.public}`, { token: friend.token })).status, 200);

    // A stranger only gets the public one.
    assert.equal((await request("GET", `/stories/${ids.private}`, { token: stranger.token })).status, 404);
    assert.equal((await request("GET", `/stories/${ids.friends}`, { token: stranger.token })).status, 404);
    assert.equal((await request("GET", `/stories/${ids.public}`, { token: stranger.token })).status, 200);
});

test("the friends feed carries friends' shared stories and nothing else", async () => {
    const ada = await signupAndLogin("feedauthor");
    const friend = await signupAndLogin("feedfriend");
    const stranger = await signupAndLogin("feedstranger");

    // Before there's any friendship, the feed is empty for everyone.
    const privateConv = await conversationWith(ada.token, ["private thoughts"]);
    await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: privateConv, title: "Private one", visibility: "private" },
    });
    const friendsConv = await conversationWith(ada.token, ["for my friends"]);
    await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: friendsConv, title: "Friends one", visibility: "friends" },
    });

    assert.deepEqual((await request("GET", "/stories/friends", { token: friend.token })).body, []);

    await befriend(ada, friend);
    const feed = await request("GET", "/stories/friends", { token: friend.token });
    assert.deepEqual(
        feed.body.map((story) => story.title),
        ["Friends one"]
    );
    // Cards don't ship the full text -- that's fetched per story.
    assert.equal(feed.body[0].content, undefined);
    assert.equal(feed.body[0].author, ada.username);

    // A stranger's feed is unaffected, and the author's own story isn't in
    // their own friends feed.
    assert.deepEqual((await request("GET", "/stories/friends", { token: stranger.token })).body, []);
    assert.deepEqual((await request("GET", "/stories/friends", { token: ada.token })).body, []);
});

test("the community feed is every public story, newest first", async () => {
    const ada = await signupAndLogin("communityada");
    const grace = await signupAndLogin("communitygrace");

    const hidden = await conversationWith(ada.token, ["not for everyone"]);
    await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: hidden, title: "Hidden", visibility: "friends" },
    });

    const older = await conversationWith(ada.token, ["older public memory"]);
    await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: older, title: "Older public", visibility: "public" },
    });
    const newer = await conversationWith(grace.token, ["newer public memory"]);
    await request("POST", "/stories", {
        token: grace.token,
        body: { conversation_id: newer, title: "Newer public", visibility: "public" },
    });

    const feed = await request("GET", "/stories/community", { token: grace.token });
    const titles = feed.body.map((story) => story.title);
    assert.ok(!titles.includes("Hidden"));
    // Newest first, and the caller's own public story is included.
    assert.ok(titles.indexOf("Newer public") < titles.indexOf("Older public"));
});

test("a story reports whether the reader is the author or their friend", async () => {
    const ada = await signupAndLogin("flagauthor");
    const friend = await signupAndLogin("flagfriend");
    const stranger = await signupAndLogin("flagstranger");
    await befriend(ada, friend);

    const conversationId = await conversationWith(ada.token, ["a public memory"]);
    const storyId = (
        await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: "Open to all", visibility: "public" },
        })
    ).body.story_id;

    const own = await request("GET", `/stories/${storyId}`, { token: ada.token });
    assert.equal(own.body.is_author, true);
    assert.equal(own.body.author_is_friend, false);

    const byFriend = await request("GET", `/stories/${storyId}`, { token: friend.token });
    assert.equal(byFriend.body.is_author, false);
    assert.equal(byFriend.body.author_is_friend, true);

    const byStranger = await request("GET", `/stories/${storyId}`, { token: stranger.token });
    assert.equal(byStranger.body.is_author, false);
    assert.equal(byStranger.body.author_is_friend, false);
});

test("a published story is a snapshot, not a live view of the conversation", async () => {
    const ada = await signupAndLogin("snapshot");
    const conversationId = await conversationWith(ada.token, ["what I said at the time"]);
    const storyId = (
        await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: "Snapshot", visibility: "public" },
        })
    ).body.story_id;

    await request("POST", `/conversations/${conversationId}/prompts`, {
        token: ada.token,
        body: { content: "something I added later" },
    });

    const story = await request("GET", `/stories/${storyId}`, { token: ada.token });
    assert.equal(story.body.content, "what I said at the time");
});

test("patching changes only the fields sent", async () => {
    const ada = await signupAndLogin("patcher");
    const stranger = await signupAndLogin("patchstranger");
    const conversationId = await conversationWith(ada.token, ["the memory"]);
    const story = (
        await request("POST", "/stories", {
            token: ada.token,
            body: {
                conversation_id: conversationId,
                title: "Original",
                summary: "Original summary",
                tags: ["Family"],
                visibility: "private",
            },
        })
    ).body;

    const patched = await request("PATCH", `/stories/${story.story_id}`, {
        token: ada.token,
        body: { visibility: "public" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.visibility, "public");
    assert.equal(patched.body.title, "Original");
    assert.equal(patched.body.summary, "Original summary");
    assert.deepEqual(patched.body.tags, ["Family"]);

    // Someone else's story isn't theirs to edit -- even now that it's public.
    assert.equal(
        (await request("PATCH", `/stories/${story.story_id}`, { token: stranger.token, body: { title: "Mine now" } }))
            .status,
        404
    );
    assert.equal(
        (await request("PATCH", `/stories/${story.story_id}`, { token: ada.token, body: { visibility: "secret" } }))
            .status,
        400
    );
});

test("unpublishing removes the story but keeps the conversation", async () => {
    const ada = await signupAndLogin("unpublisher");
    const stranger = await signupAndLogin("unpublishstranger");
    const conversationId = await conversationWith(ada.token, ["a memory"]);
    const storyId = (
        await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: "Temporary", visibility: "public" },
        })
    ).body.story_id;

    assert.equal((await request("DELETE", `/stories/${storyId}`, { token: stranger.token })).status, 404);
    assert.equal((await request("DELETE", `/stories/${storyId}`, { token: ada.token })).status, 200);

    assert.equal((await request("GET", `/stories/${storyId}`, { token: ada.token })).status, 404);
    assert.equal((await request("GET", `/conversations/${conversationId}`, { token: ada.token })).status, 200);

    // Freed up to be published again.
    const again = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Second go" },
    });
    assert.equal(again.status, 201);
});

test("a conversation reports the story it was published as", async () => {
    const ada = await signupAndLogin("lookup");
    const stranger = await signupAndLogin("lookupstranger");
    const conversationId = await conversationWith(ada.token, ["a memory"]);

    assert.equal((await request("GET", `/conversations/${conversationId}/story`, { token: ada.token })).status, 204);

    await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Published", visibility: "friends" },
    });

    const found = await request("GET", `/conversations/${conversationId}/story`, { token: ada.token });
    assert.equal(found.status, 200);
    assert.equal(found.body.title, "Published");
    // The edit form needs the text back, so this one does include content.
    assert.equal(found.body.content, "a memory");

    // Someone else's conversation looks unpublished rather than 404-ing, which
    // would confirm the conversation exists.
    assert.equal(
        (await request("GET", `/conversations/${conversationId}/story`, { token: stranger.token })).status,
        204
    );
});

test("oversized and malformed fields are rejected", async () => {
    const ada = await signupAndLogin("limits");
    const conversationId = await conversationWith(ada.token, ["a memory"]);

    const tooLong = async (body) =>
        (await request("POST", "/stories", { token: ada.token, body: { conversation_id: conversationId, ...body } }))
            .status;

    assert.equal(await tooLong({ title: "x".repeat(121) }), 400);
    assert.equal(await tooLong({ title: "ok", summary: "x".repeat(501) }), 400);
    assert.equal(await tooLong({ title: "ok", place: "x".repeat(101) }), 400);
    assert.equal(await tooLong({ title: "ok", tags: ["a", "b", "c", "d", "e", "f", "g"] }), 400);
    assert.equal(await tooLong({ title: "ok", tags: ["x".repeat(41)] }), 400);
    assert.equal(await tooLong({ title: "ok", conversation_id: "not-a-number" }), 400);
});

test("story endpoints require a session", async () => {
    for (const [method, urlPath] of [
        ["POST", "/stories"],
        ["GET", "/stories/mine"],
        ["GET", "/stories/friends"],
        ["GET", "/stories/community"],
        ["GET", "/stories/1"],
    ]) {
        assert.equal((await request(method, urlPath)).status, 401, `${method} ${urlPath}`);
    }
});
