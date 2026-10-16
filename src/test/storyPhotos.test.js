// Tests for story photos (storyPhotos.js, and photo_ids on /stories) -- the
// pictures published together with a story. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-story-photos-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-story-photos-media-"));

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
    const parsed = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body: parsed };
}

let userCounter = 0;
async function signupAndLogin(prefix, password = "password123") {
    const username = `${prefix}${userCounter++}`;
    const email = `${username}@example.com`;
    await request("POST", "/signup", { body: { username, email, password } });
    const token = (await request("POST", "/login", { body: { email, password } })).body.token;
    return { username, email, token };
}

async function conversationWith(token, messages) {
    const conversationId = (await request("POST", "/conversations", { token })).body.conversation_id;
    for (const content of messages) {
        await request("POST", `/conversations/${conversationId}/prompts`, { token, body: { content } });
    }
    return conversationId;
}

// The smallest files that pass the JPG/PNG check (it reads the first bytes).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

async function upload(token, bytes = PNG, filename = "photo.png") {
    return request("POST", "/stories/photos", { token, body: { filename, data_base64: bytes.toString("base64") } });
}

const fileOf = (url) => path.join(process.env.MEDIA_ROOT, "story_photos", path.basename(url));
const served = async (url) => (await fetch(`${baseUrl}${url}`)).status;

test("photos are published with a story, in order, the first being the cover", async () => {
    const ada = await signupAndLogin("photoauthor");
    const first = await upload(ada.token, PNG, "a.png");
    const second = await upload(ada.token, JPG, "b.jpg");
    assert.equal(first.status, 201);
    assert.match(first.body.url, /^\/story-photos\/[a-f0-9]{32}\.png$/);
    assert.match(second.body.url, /\.jpg$/);

    // Served as soon as it's uploaded, so the dialog can show it.
    const image = await fetch(`${baseUrl}${first.body.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");

    const conversationId = await conversationWith(ada.token, ["a memory"]);
    const published = await request("POST", "/stories", {
        token: ada.token,
        body: {
            conversation_id: conversationId,
            title: "With pictures",
            visibility: "public",
            photo_ids: [second.body.photo_id, first.body.photo_id],
        },
    });
    assert.equal(published.status, 201);
    assert.deepEqual(
        published.body.photos.map((photo) => photo.photo_id),
        [second.body.photo_id, first.body.photo_id]
    );
    assert.equal(published.body.photo, second.body.url);

    // The feeds carry them too, for the card covers.
    const community = (await request("GET", "/stories/community", { token: ada.token })).body;
    const card = community.find((story) => story.story_id === published.body.story_id);
    assert.equal(card.photo, second.body.url);
    assert.equal(card.photos.length, 2);

    // Publishing again without photo_ids leaves them be.
    const again = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Retitled", visibility: "public" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.photos.length, 2);
});

test("a story without photos keeps the old cover field", async () => {
    const ada = await signupAndLogin("nophotos");
    const conversationId = await conversationWith(ada.token, ["plain"]);
    const story = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: conversationId, title: "Plain" },
    });
    assert.deepEqual(story.body.photos, []);
    assert.equal(story.body.photo, "profile.jpg");
});

test("removing or reordering photos on edit, and deleting the story, cleans up the files", async () => {
    const ada = await signupAndLogin("photoeditor");
    const photos = [];
    for (let i = 0; i < 3; i++) photos.push((await upload(ada.token)).body);
    const conversationId = await conversationWith(ada.token, ["a memory"]);
    const story = (
        await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: "Album", photo_ids: photos.map((p) => p.photo_id) },
        })
    ).body;

    // Drop the middle one and swap the other two.
    const patched = await request("PATCH", `/stories/${story.story_id}`, {
        token: ada.token,
        body: { photo_ids: [photos[2].photo_id, photos[0].photo_id] },
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(
        patched.body.photos.map((p) => p.photo_id),
        [photos[2].photo_id, photos[0].photo_id]
    );
    assert.equal(fs.existsSync(fileOf(photos[1].url)), false);
    assert.equal(await served(photos[1].url), 404);

    // Editing something else leaves the photos alone.
    const retitled = await request("PATCH", `/stories/${story.story_id}`, { token: ada.token, body: { title: "New" } });
    assert.equal(retitled.body.photos.length, 2);

    assert.equal((await request("DELETE", `/stories/${story.story_id}`, { token: ada.token })).status, 200);
    for (const photo of [photos[0], photos[2]]) {
        assert.equal(fs.existsSync(fileOf(photo.url)), false);
        assert.equal(await served(photo.url), 404);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM story_photos WHERE story_id = ?").get(story.story_id).n, 0);
});


test("only your own, unused photos can be put on a story", async () => {
    const ada = await signupAndLogin("photoowner");
    const eve = await signupAndLogin("photothief");
    const adas = (await upload(ada.token)).body;
    const conversationId = await conversationWith(ada.token, ["mine"]);
    const story = (
        await request("POST", "/stories", {
            token: ada.token,
            body: { conversation_id: conversationId, title: "Mine", photo_ids: [adas.photo_id] },
        })
    ).body;

    // Someone else's photo is refused, and nothing is published.
    const eveConversation = await conversationWith(eve.token, ["theirs"]);
    const stolen = await request("POST", "/stories", {
        token: eve.token,
        body: { conversation_id: eveConversation, title: "Stolen", photo_ids: [adas.photo_id] },
    });
    assert.equal(stolen.status, 400);
    assert.equal((await request("GET", "/stories/mine", { token: eve.token })).body.length, 0);

    // So is one already on another of your stories.
    const otherConversation = await conversationWith(ada.token, ["another"]);
    const reused = await request("POST", "/stories", {
        token: ada.token,
        body: { conversation_id: otherConversation, title: "Again", photo_ids: [adas.photo_id] },
    });
    assert.equal(reused.status, 400);

    // Bad lists: not a list, not ids, a duplicate, too many.
    const patch = (photo_ids) =>
        request("PATCH", `/stories/${story.story_id}`, { token: ada.token, body: { photo_ids } });
    assert.equal((await patch("1")).status, 400);
    assert.equal((await patch(["x"])).status, 400);
    assert.equal((await patch([adas.photo_id, adas.photo_id])).status, 400);
    assert.equal((await patch(Array.from({ length: 11 }, (_, i) => i + 1))).status, 400);
    // A refused edit leaves the story as it was.
    const kept = await request("GET", `/stories/${story.story_id}`, { token: ada.token });
    assert.deepEqual(
        kept.body.photos.map((p) => p.photo_id),
        [adas.photo_id]
    );
});

test("uploads must be JPG or PNG, under 5 MB, and signed in", async () => {
    const ada = await signupAndLogin("photorules");
    assert.equal((await upload(ada.token, Buffer.from("GIF89a....."), "x.gif")).status, 400);
    assert.equal((await request("POST", "/stories/photos", { token: ada.token, body: {} })).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal((await upload(ada.token, big)).status, 413);
    assert.equal((await upload(undefined)).status, 401);
});

test("only generated, known names are served", async () => {
    assert.equal((await fetch(`${baseUrl}/story-photos/..%2F..%2Fapp.db`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/story-photos/${"a".repeat(32)}.png`)).status, 404);
});

test("uploads never published are cleared after a day", async () => {
    const ada = await signupAndLogin("photostale");
    const old = (await upload(ada.token)).body;
    db.prepare("UPDATE story_photos SET created_at = ? WHERE photo_id = ?").run(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        old.photo_id
    );
    // The next upload sweeps it away.
    assert.equal((await upload(ada.token)).status, 201);
    assert.equal(db.prepare("SELECT 1 FROM story_photos WHERE photo_id = ?").get(old.photo_id), undefined);
    assert.equal(fs.existsSync(fileOf(old.url)), false);
});

