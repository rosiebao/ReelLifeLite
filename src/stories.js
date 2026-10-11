// /stories -- publishing a "Tell Your Story" conversation so other people can
// read it in the Friends and Community tabs.
//
// A story is a *snapshot*: the text is copied into stories.content when it's
// published and only changes when the author publishes or edits again. Reading
// it back out of the conversation on every request would mean a later message
// silently rewriting something friends have already read, and would tie a
// published story's lifetime to a conversation the author may want to delete.
//
// Who can see what is decided in exactly one place -- visibleStoryFilter() --
// so the three feeds and the single-story fetch can't drift apart.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { friendIdsOf, areFriends } = require("./friends");

const router = express.Router();

const VISIBILITIES = ["private", "friends", "public"];
const DEFAULT_VISIBILITY = "private";
const DEFAULT_PHOTO = "profile.jpg";

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 500;
const MAX_CONTENT_LENGTH = 100000;
const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 40;
const MAX_PLACE_LENGTH = 100;
const MAX_TIME_PERIOD_LENGTH = 100;
const MAX_PHOTO_LENGTH = 2048;

// ---- Field parsing ----

function parseText(value, { field, max, fallback = "" }) {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    if (text.length > max) throw new ApiError(400, `${field} is too long (max ${max} characters)`);
    return text;
}

function parseVisibility(value, fallback = DEFAULT_VISIBILITY) {
    if (value === undefined || value === null || value === "") return fallback;
    const visibility = String(value);
    if (!VISIBILITIES.includes(visibility)) {
        throw new ApiError(400, `Visibility must be one of: ${VISIBILITIES.join(", ")}`);
    }
    return visibility;
}

// Tags arrive either as an array (the publish form) or as one string someone
// typed ("#family, #food"). Both end up as a clean list with no leading '#',
// stored comma-separated and handed back to clients as an array.
function parseTags(value) {
    if (value === undefined || value === null) return [];
    const raw = Array.isArray(value) ? value : String(value).split(",");

    const tags = [];
    for (const entry of raw) {
        const tag = String(entry).trim().replace(/^#+/, "").trim();
        if (!tag) continue;
        if (tag.length > MAX_TAG_LENGTH) throw new ApiError(400, `Tag "${tag}" is too long`);
        // A tag with a comma in it would come back as two tags when the stored
        // string is split again.
        if (tag.includes(",")) throw new ApiError(400, "Tags cannot contain commas");
        if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_TAGS) throw new ApiError(400, `A story can have at most ${MAX_TAGS} tags`);
    return tags;
}

// ---- Rows in, JSON out ----

// The author's own messages, in order, as the story text. The assistant's
// canned replies are interview prompts that got the memory out of them -- they
// belong in the conversation, not in the thing other people sit down to read.
// The author can send their own `content` to override this when publishing.
function contentFromConversation(conversationId) {
    const prompts = db
        .prepare("SELECT content FROM prompts WHERE conversation_id = ? ORDER BY prompt_time, prompt_id")
        .all(conversationId);
    return prompts
        .map((prompt) => prompt.content.trim())
        .filter(Boolean)
        .join("\n\n");
}

// `includeContent` is off for the feeds: a card only shows title/summary/tags,
// and shipping every full story to build a grid of them adds up fast.
function storyJson(row, { includeContent = false } = {}) {
    const story = {
        story_id: row.story_id,
        user_id: row.user_id,
        author: row.author,
        conversation_id: row.conversation_id,
        title: row.title,
        summary: row.summary,
        tags: row.tags ? row.tags.split(",") : [],
        place: row.place,
        time_period: row.time_period,
        photo: row.photo,
        visibility: row.visibility,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
    if (includeContent) story.content = row.content;
    return story;
}

const SELECT_STORY = `
    SELECT s.*, u.username AS author
    FROM stories s JOIN users u ON u.id = s.user_id
`;

// ---- Visibility ----

// The one definition of "userId is allowed to read this story": their own, or
// public, or a friend's story shared with friends. Returns a SQL fragment and
// its parameters so the feeds and the single fetch share the same rule.
//
// The friend ids are inlined as literals rather than bound parameters because
// the list is variable-length; they come from friendIdsOf(), which returns
// integers straight out of SQLite, so there's no user-supplied text here.
function visibleStoryFilter(userId) {
    const friendIds = friendIdsOf(userId).map(Number).filter(Number.isInteger);
    const friendList = friendIds.length ? friendIds.join(",") : "NULL";
    return {
        sql: `(
            s.user_id = ?
            OR s.visibility = 'public'
            OR (s.visibility = 'friends' AND s.user_id IN (${friendList}))
        )`,
        params: [userId],
    };
}

function readableStory(storyId, userId) {
    const filter = visibleStoryFilter(userId);
    const row = db
        .prepare(`${SELECT_STORY} WHERE s.story_id = ? AND ${filter.sql}`)
        .get(storyId, ...filter.params);
    if (!row) throw new ApiError(404, "Story not found");
    return row;
}

function ownedStory(storyId, userId) {
    const row = db.prepare(`${SELECT_STORY} WHERE s.story_id = ? AND s.user_id = ?`).get(storyId, userId);
    if (!row) throw new ApiError(404, "Story not found");
    return row;
}

// ---- Publishing ----

// Publishing the same conversation again edits its existing story rather than
// adding a second one -- the unique index on stories.conversation_id enforces
// that, and the author's feed shouldn't fill up with near-identical copies.
router.post("/stories", requireAuth, (req, res) => {
    const conversationId = req.body?.conversation_id === undefined ? null : Number(req.body.conversation_id);
    if (conversationId !== null && !Number.isInteger(conversationId)) {
        throw new ApiError(400, "conversation_id must be a number");
    }

    if (conversationId !== null) {
        const conversation = db
            .prepare("SELECT conversation_id FROM conversation WHERE conversation_id = ? AND user_id = ?")
            .get(conversationId, req.user.id);
        if (!conversation) throw new ApiError(404, "Conversation not found");
    }

    const title = parseText(req.body?.title, { field: "Title", max: MAX_TITLE_LENGTH });
    if (!title) throw new ApiError(400, "Title cannot be empty");

    const content = parseText(req.body?.content, {
        field: "Story content",
        max: MAX_CONTENT_LENGTH,
        fallback: conversationId === null ? "" : contentFromConversation(conversationId),
    });
    if (!content) throw new ApiError(400, "There's nothing to publish yet -- tell some of your story first");

    const story = {
        title,
        content,
        summary: parseText(req.body?.summary, { field: "Summary", max: MAX_SUMMARY_LENGTH }),
        tags: parseTags(req.body?.tags).join(","),
        place: parseText(req.body?.place, { field: "Place", max: MAX_PLACE_LENGTH }),
        time_period: parseText(req.body?.time_period, { field: "Time period", max: MAX_TIME_PERIOD_LENGTH }),
        photo: parseText(req.body?.photo, { field: "Photo", max: MAX_PHOTO_LENGTH, fallback: DEFAULT_PHOTO }),
        visibility: parseVisibility(req.body?.visibility),
    };
    const now = new Date().toISOString();

    const existing =
        conversationId === null
            ? null
            : db.prepare("SELECT story_id FROM stories WHERE conversation_id = ?").get(conversationId);

    if (existing) {
        db.prepare(
            `UPDATE stories SET title = ?, summary = ?, content = ?, tags = ?, place = ?,
             time_period = ?, photo = ?, visibility = ?, updated_at = ? WHERE story_id = ?`
        ).run(
            story.title,
            story.summary,
            story.content,
            story.tags,
            story.place,
            story.time_period,
            story.photo,
            story.visibility,
            now,
            existing.story_id
        );
        res.status(200).json(storyJson(ownedStory(existing.story_id, req.user.id), { includeContent: true }));
        return;
    }

    const info = db
        .prepare(
            `INSERT INTO stories (user_id, conversation_id, title, summary, content, tags, place,
             time_period, photo, visibility, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            req.user.id,
            conversationId,
            story.title,
            story.summary,
            story.content,
            story.tags,
            story.place,
            story.time_period,
            story.photo,
            story.visibility,
            now,
            now
        );

    res.status(201).json(storyJson(ownedStory(Number(info.lastInsertRowid), req.user.id), { includeContent: true }));
});

// ---- Feeds ----
// These three have to be declared before /stories/:id, or "mine" and friends"
// would be matched as story ids.

router.get("/stories/mine", requireAuth, (req, res) => {
    const rows = db
        .prepare(`${SELECT_STORY} WHERE s.user_id = ? ORDER BY s.created_at DESC`)
        .all(req.user.id);
    res.json(rows.map((row) => storyJson(row)));
});

// Friends' stories only -- the author's own published stories live on the
// Story tab, and repeating them here would bury what friends have posted.
router.get("/stories/friends", requireAuth, (req, res) => {
    const friendIds = friendIdsOf(req.user.id).map(Number).filter(Number.isInteger);
    if (!friendIds.length) {
        res.json([]);
        return;
    }

    const rows = db
        .prepare(
            `${SELECT_STORY}
             WHERE s.user_id IN (${friendIds.join(",")})
               AND s.visibility IN ('friends', 'public')
             ORDER BY s.created_at DESC`
        )
        .all();
    res.json(rows.map((row) => storyJson(row)));
});

// Everything public, the caller's own included -- the Community tab is the
// whole site, not "other people".
router.get("/stories/community", requireAuth, (req, res) => {
    const rows = db
        .prepare(`${SELECT_STORY} WHERE s.visibility = 'public' ORDER BY s.created_at DESC`)
        .all();
    res.json(rows.map((row) => storyJson(row)));
});

// The story a given conversation was published as, so the Story tab can show
// whether it's been published and pre-fill the publish form with what's
// already there. 204 when it hasn't been published.
router.get("/conversations/:id/story", requireAuth, (req, res) => {
    const row = db
        .prepare(`${SELECT_STORY} WHERE s.conversation_id = ? AND s.user_id = ?`)
        .get(Number(req.params.id), req.user.id);
    if (!row) {
        res.status(204).end();
        return;
    }
    res.json(storyJson(row, { includeContent: true }));
});

// ---- One story ----

router.get("/stories/:id", requireAuth, (req, res) => {
    const row = readableStory(Number(req.params.id), req.user.id);
    res.json({
        ...storyJson(row, { includeContent: true }),
        // Lets the reader offer "Add friend" on a public story from someone
        // the reader doesn't know yet.
        is_author: row.user_id === req.user.id,
        author_is_friend: row.user_id !== req.user.id && areFriends(req.user.id, row.user_id),
    });
});

// Changing visibility is the common case ("actually, make this public"), so
// every field is optional and anything left out keeps its current value.
router.patch("/stories/:id", requireAuth, (req, res) => {
    const current = ownedStory(Number(req.params.id), req.user.id);
    const body = req.body || {};
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

    const title = has("title") ? parseText(body.title, { field: "Title", max: MAX_TITLE_LENGTH }) : current.title;
    if (!title) throw new ApiError(400, "Title cannot be empty");

    const content = has("content")
        ? parseText(body.content, { field: "Story content", max: MAX_CONTENT_LENGTH })
        : current.content;
    if (!content) throw new ApiError(400, "Story content cannot be empty");

    db.prepare(
        `UPDATE stories SET title = ?, summary = ?, content = ?, tags = ?, place = ?,
         time_period = ?, photo = ?, visibility = ?, updated_at = ? WHERE story_id = ?`
    ).run(
        title,
        has("summary") ? parseText(body.summary, { field: "Summary", max: MAX_SUMMARY_LENGTH }) : current.summary,
        content,
        has("tags") ? parseTags(body.tags).join(",") : current.tags,
        has("place") ? parseText(body.place, { field: "Place", max: MAX_PLACE_LENGTH }) : current.place,
        has("time_period")
            ? parseText(body.time_period, { field: "Time period", max: MAX_TIME_PERIOD_LENGTH })
            : current.time_period,
        has("photo")
            ? parseText(body.photo, { field: "Photo", max: MAX_PHOTO_LENGTH, fallback: DEFAULT_PHOTO })
            : current.photo,
        has("visibility") ? parseVisibility(body.visibility, current.visibility) : current.visibility,
        new Date().toISOString(),
        current.story_id
    );

    res.json(storyJson(ownedStory(current.story_id, req.user.id), { includeContent: true }));
});

// Unpublishing for good. The conversation it came from is untouched, so the
// author can publish it again later.
router.delete("/stories/:id", requireAuth, (req, res) => {
    const story = ownedStory(Number(req.params.id), req.user.id);
    db.prepare("DELETE FROM stories WHERE story_id = ?").run(story.story_id);
    res.json({ ok: true });
});

module.exports = { router };
