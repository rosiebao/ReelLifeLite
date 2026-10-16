// /profile -- the profile page: name, location, a few lines about yourself, a
// photo, and who else gets to see them. The login details (username, email)
// are edited here too, with the same rules /signup applies.
//
// Photos are stored as files under MEDIA_ROOT/profile_photos with a random
// name (the database only keeps that name) and served from
// /profile-photos/<name>. The name can't be guessed, but the file itself isn't
// behind a login: an <img> tag can't send the bearer token.

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { areFriends } = require("./friends");

const router = express.Router();

const MAX_NAME_LENGTH = 50;
const MAX_USERNAME_LENGTH = 30;
const MAX_LOCATION_LENGTH = 100;
const MAX_BIO_LENGTH = 500;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PROFILE_VISIBILITIES = ["friends", "community"];

// JPG and PNG only, told apart by their first bytes rather than whatever the
// browser said the file was. Story photos (storyPhotos.js) use the same rules.
const PHOTO_TYPES = [
    { extension: "jpg", magic: Buffer.from([0xff, 0xd8, 0xff]) },
    { extension: "png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
];
const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png)$/;

// Read when needed rather than once, so the tests' MEDIA_ROOT (set before the
// app is required) is the one used.
function photoDir() {
    const root = process.env.MEDIA_ROOT || path.join(__dirname, "conversation_files");
    return path.join(root, "profile_photos");
}

function photoUrl(name) {
    return name ? `/profile-photos/${name}` : null;
}

function removePhotoFile(name) {
    if (name && PHOTO_NAME.test(name)) fs.rmSync(path.join(photoDir(), name), { force: true });
}

function cleanText(value, { field, max }) {
    const text = String(value ?? "").trim();
    if (text.length > max) throw new ApiError(400, `${field} is too long (max ${max} characters)`);
    return text || null;
}

function loadUser(id) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!user) throw new ApiError(404, "User not found");
    return user;
}

// Everything, for the user themselves.
function ownProfileJson(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        first_name: user.first_name || "",
        last_name: user.last_name || "",
        location: user.location || "",
        bio: user.bio || "",
        photo_url: photoUrl(user.photo),
        profile_visibility: user.profile_visibility || "friends",
        show_location: Boolean(user.show_location),
        show_email: Boolean(user.show_email),
        created_at: user.created_at,
    };
}

router.get("/profile", requireAuth, (req, res) => {
    res.json(ownProfileJson(loadUser(req.user.id)));
});

// Partial update: only the fields that are sent change, so the visibility
// switches can save on their own without resending the whole form.
router.put("/profile", requireAuth, (req, res) => {
    const body = req.body || {};
    const user = loadUser(req.user.id);
    const changes = {};

    for (const [key, field, max] of [
        ["first_name", "First name", MAX_NAME_LENGTH],
        ["last_name", "Last name", MAX_NAME_LENGTH],
        ["location", "Location", MAX_LOCATION_LENGTH],
        ["bio", "About you", MAX_BIO_LENGTH],
    ]) {
        if (body[key] !== undefined) changes[key] = cleanText(body[key], { field, max });
    }

    if (body.username !== undefined) {
        const username = cleanText(body.username, { field: "Username", max: MAX_USERNAME_LENGTH });
        if (!username) throw new ApiError(400, "Username cannot be empty");
        if (username !== user.username) {
            if (db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username, user.id)) {
                throw new ApiError(409, "Username already taken");
            }
            changes.username = username;
        }
    }
    if (body.email !== undefined) {
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!email || !email.includes("@")) throw new ApiError(400, "Invalid email address");
        if (email !== user.email) {
            if (db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, user.id)) {
                throw new ApiError(409, "Email already registered");
            }
            changes.email = email;
        }
    }

    if (body.profile_visibility !== undefined) {
        const visibility = String(body.profile_visibility);
        if (!PROFILE_VISIBILITIES.includes(visibility)) {
            throw new ApiError(400, `Profile visibility must be one of: ${PROFILE_VISIBILITIES.join(", ")}`);
        }
        changes.profile_visibility = visibility;
    }
    for (const flag of ["show_location", "show_email"]) {
        if (body[flag] === undefined) continue;
        if (typeof body[flag] !== "boolean") throw new ApiError(400, `${flag} must be true or false`);
        changes[flag] = body[flag] ? 1 : 0;
    }

    const columns = Object.keys(changes);
    if (columns.length) {
        // Column names come from the fixed lists above, never from the request.
        db.prepare(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
            ...columns.map((column) => changes[column]),
            user.id
        );
    }
    res.json(ownProfileJson(loadUser(user.id)));
});

// {"filename", "data_base64"} -- the same base64-in-JSON shape the
// conversation media uses. app.js gives this route a larger body limit.
router.put("/profile/photo", requireAuth, (req, res) => {
    const base64 = String(req.body?.data_base64 || "").replace(/^data:[^,]*,/, "");
    if (!base64) throw new ApiError(400, "No photo was sent");

    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_PHOTO_BYTES) throw new ApiError(413, "Photos can be up to 5 MB");
    const type = PHOTO_TYPES.find((candidate) => bytes.subarray(0, candidate.magic.length).equals(candidate.magic));
    if (!type) throw new ApiError(400, "Photos must be JPG or PNG");

    const user = loadUser(req.user.id);
    const name = `${crypto.randomBytes(16).toString("hex")}.${type.extension}`;
    fs.mkdirSync(photoDir(), { recursive: true });
    fs.writeFileSync(path.join(photoDir(), name), bytes);
    db.prepare("UPDATE users SET photo = ? WHERE id = ?").run(name, user.id);
    // The old one is no longer linked from anywhere.
    removePhotoFile(user.photo);
    res.json(ownProfileJson(loadUser(user.id)));
});

router.delete("/profile/photo", requireAuth, (req, res) => {
    const user = loadUser(req.user.id);
    removePhotoFile(user.photo);
    db.prepare("UPDATE users SET photo = NULL WHERE id = ?").run(user.id);
    res.json(ownProfileJson(loadUser(user.id)));
});

// Only names this file generated are served, so "../" can't reach anything else.
router.get("/profile-photos/:name", (req, res) => {
    const name = req.params.name;
    if (!PHOTO_NAME.test(name)) throw new ApiError(404, "Photo not found");
    const file = path.join(photoDir(), name);
    if (!fs.existsSync(file)) throw new ApiError(404, "Photo not found");
    res.sendFile(file);
});

// Someone else's profile, as far as they let you see it. "friends" profiles
// are friends-only; "community" is any signed-in user. Location and email go
// out only when switched on. A hidden profile is a 404, not a 403, so it
// doesn't confirm who has an account.
router.get("/users/:id/profile", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(404, "User not found");
    const user = loadUser(id);
    if (user.id === req.user.id) {
        res.json(ownProfileJson(user));
        return;
    }
    if ((user.profile_visibility || "friends") === "friends" && !areFriends(req.user.id, user.id)) {
        throw new ApiError(404, "User not found");
    }
    res.json({
        id: user.id,
        username: user.username,
        first_name: user.first_name || "",
        last_name: user.last_name || "",
        bio: user.bio || "",
        photo_url: photoUrl(user.photo),
        location: user.show_location ? user.location || "" : null,
        email: user.show_email ? user.email : null,
        created_at: user.created_at,
    });
});

module.exports = { router, MAX_PHOTO_BYTES, PHOTO_TYPES, photoUrl };
