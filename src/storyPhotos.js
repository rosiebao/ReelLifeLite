// Photos published together with a story.
//
// The publish dialog uploads each picture as soon as it's chosen
// (POST /stories/photos), before the story is saved -- a story being published
// for the first time doesn't exist yet. An upload starts out unattached; saving
// the story with `photo_ids` (../stories.js) attaches the listed ones, in that
// order, the first being the cover on the feed cards. A photo dropped from the
// list, or one belonging to a deleted story, has its file removed. Uploads
// that never get attached are cleared out after a day.
//
// Files live under MEDIA_ROOT/story_photos with a random 32-hex name, and are
// served (GET /story-photos/:name) without the login check, like profile
// photos: an <img> can't send the token. The URL is only ever handed out with
// a story the caller is allowed to read, and the random name is what keeps it
// from being guessed.
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { MAX_PHOTO_BYTES, PHOTO_TYPES } = require("./profile");

const router = express.Router();

const MAX_PHOTOS_PER_STORY = 10;
// Uploads waiting to be published, per user, so the disk can't be filled by
// uploading without ever saving.
const MAX_UNATTACHED_PHOTOS = 30;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;
const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png)$/;

// Read when needed rather than once, so the tests' MEDIA_ROOT (set before the
// app is required) is the one used.
function photoDir() {
    const root = process.env.MEDIA_ROOT || path.join(__dirname, "conversation_files");
    return path.join(root, "story_photos");
}

function photoUrl(fileName) {
    return `/story-photos/${fileName}`;
}

function photoJson(row) {
    return { photo_id: row.photo_id, url: photoUrl(row.file_name) };
}

// Ids as a SQL list literal. Callers only pass integers they've checked (or
// read back out of SQLite), so there's no user-supplied text here.
function idList(ids) {
    return ids.map(Number).filter(Number.isInteger).join(",");
}

// A file that can't be removed is logged, not reported: the row is already
// gone, and the random name means nothing links to it any more.
function removeFiles(fileNames) {
    for (const name of fileNames) {
        if (!PHOTO_NAME.test(name)) continue;
        try {
            fs.rmSync(path.join(photoDir(), name), { force: true });
        } catch (err) {
            console.error(`Couldn't remove story photo ${name}:`, err);
        }
    }
}

// The user's uploads that were never published and are over a day old.
function clearStaleUploads(userId) {
    const cutoff = new Date(Date.now() - UNATTACHED_TTL_MS).toISOString();
    const stale = db
        .prepare("SELECT photo_id, file_name FROM story_photos WHERE user_id = ? AND story_id IS NULL AND created_at < ?")
        .all(userId, cutoff);
    if (!stale.length) return;
    db.prepare(`DELETE FROM story_photos WHERE photo_id IN (${idList(stale.map((row) => row.photo_id))})`).run();
    removeFiles(stale.map((row) => row.file_name));
}

// ---- Used by ../stories.js ----

// Every listed story's photos, in order: Map(story_id -> [{photo_id, url}]).
// One query for a whole feed rather than one per card.
function photosByStory(storyIds) {
    const ids = [...new Set(storyIds.map(Number).filter(Number.isInteger))];
    const map = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return map;
    const rows = db
        .prepare(
            `SELECT photo_id, story_id, file_name FROM story_photos
             WHERE story_id IN (${idList(ids)}) ORDER BY story_id, position, photo_id`
        )
        .all();
    for (const row of rows) map.get(row.story_id).push(photoJson(row));
    return map;
}

// Checks a story's `photo_ids` before anything is written, so a bad list
// leaves the story as it was. Each must be the caller's own upload, either not
// yet attached or already on this story. undefined = "leave the photos alone".
function parsePhotoIds(value, { userId, storyId = null }) {
    if (value === undefined) return undefined;
    if (value === null) return [];
    if (!Array.isArray(value)) throw new ApiError(400, "photo_ids must be a list");
    const ids = value.map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new ApiError(400, "photo_ids must be photo ids");
    if (new Set(ids).size !== ids.length) throw new ApiError(400, "A photo appears twice");
    if (ids.length > MAX_PHOTOS_PER_STORY) {
        throw new ApiError(400, `A story can have at most ${MAX_PHOTOS_PER_STORY} photos`);
    }
    if (!ids.length) return [];

    const rows = db
        .prepare(`SELECT photo_id, story_id FROM story_photos WHERE user_id = ? AND photo_id IN (${idList(ids)})`)
        .all(userId);
    const usable = new Set(
        rows.filter((row) => row.story_id === null || row.story_id === storyId).map((row) => row.photo_id)
    );
    // Someone else's photo looks exactly like one that doesn't exist.
    if (ids.some((id) => !usable.has(id))) {
        throw new ApiError(400, "One of the photos wasn't found -- try adding it again");
    }
    return ids;
}

// Makes `photoIds` (already checked by parsePhotoIds) the story's photos, in
// order, and drops the ones it no longer has. Run inside the caller's
// transaction; returns the file names to delete once that has committed.
function setStoryPhotos(storyId, photoIds) {
    const keep = photoIds.length ? `AND photo_id NOT IN (${idList(photoIds)})` : "";
    const dropped = db.prepare(`SELECT photo_id, file_name FROM story_photos WHERE story_id = ? ${keep}`).all(storyId);
    if (dropped.length) {
        db.prepare(`DELETE FROM story_photos WHERE photo_id IN (${idList(dropped.map((row) => row.photo_id))})`).run();
    }
    const attach = db.prepare("UPDATE story_photos SET story_id = ?, position = ? WHERE photo_id = ?");
    photoIds.forEach((photoId, position) => attach.run(storyId, position, photoId));
    return dropped.map((row) => row.file_name);
}

// The files of a story about to be deleted (its rows go with it, ON DELETE
// CASCADE), to remove afterwards.
function storyPhotoFiles(storyId) {
    return db
        .prepare("SELECT file_name FROM story_photos WHERE story_id = ?")
        .all(storyId)
        .map((row) => row.file_name);
}

// ---- Routes ----

// {"filename", "data_base64"} -- the same shape as PUT /profile/photo, and the
// same rules: JPG or PNG by the file's bytes, up to 5 MB. app.js gives this
// route a larger body limit. -> 201 {photo_id, url}
router.post("/stories/photos", requireAuth, (req, res) => {
    const base64 = String(req.body?.data_base64 || "").replace(/^data:[^,]*,/, "");
    if (!base64) throw new ApiError(400, "No photo was sent");

    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_PHOTO_BYTES) throw new ApiError(413, "Photos can be up to 5 MB");
    const type = PHOTO_TYPES.find((candidate) => bytes.subarray(0, candidate.magic.length).equals(candidate.magic));
    if (!type) throw new ApiError(400, "Photos must be JPG or PNG");

    clearStaleUploads(req.user.id);
    const waiting = db
        .prepare("SELECT COUNT(*) AS n FROM story_photos WHERE user_id = ? AND story_id IS NULL")
        .get(req.user.id).n;
    if (waiting >= MAX_UNATTACHED_PHOTOS) {
        throw new ApiError(429, "Too many photos waiting to be published -- publish or close the story first");
    }

    const name = `${crypto.randomBytes(16).toString("hex")}.${type.extension}`;
    fs.mkdirSync(photoDir(), { recursive: true });
    fs.writeFileSync(path.join(photoDir(), name), bytes);
    const info = db
        .prepare("INSERT INTO story_photos (user_id, file_name, created_at) VALUES (?, ?, ?)")
        .run(req.user.id, name, new Date().toISOString());
    res.status(201).json({ photo_id: Number(info.lastInsertRowid), url: photoUrl(name) });
});

// Only names this file generated, and only ones still in the table, are
// served -- so "../" can't reach anything else, and a removed photo is gone.
router.get("/story-photos/:name", (req, res) => {
    const name = req.params.name;
    if (!PHOTO_NAME.test(name)) throw new ApiError(404, "Photo not found");
    const known = db.prepare("SELECT 1 FROM story_photos WHERE file_name = ?").get(name);
    const file = path.join(photoDir(), name);
    if (!known || !fs.existsSync(file)) throw new ApiError(404, "Photo not found");
    res.sendFile(file);
});

module.exports = {
    router,
    MAX_PHOTOS_PER_STORY,
    photosByStory,
    parsePhotoIds,
    setStoryPhotos,
    storyPhotoFiles,
    removeFiles,
};

