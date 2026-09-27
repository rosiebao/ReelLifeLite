// /friends, /users/search -- the friend graph behind the Friends tab.
//
// A friendship is a single row in `friendships`, stored in the direction the
// request was sent (requester -> addressee) and flipped to 'accepted' when the
// other side agrees. Nothing here duplicates the row in the reverse direction,
// so every lookup has to consider both columns; friendRow() and friendIdsOf()
// are the two places that do it, and everything else goes through them.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");

const router = express.Router();

const MAX_SEARCH_RESULTS = 20;

// The row linking two users, whichever way round the request was sent.
function friendRow(userId, otherId) {
    return db
        .prepare(
            `SELECT * FROM friendships
             WHERE (requester_id = ? AND addressee_id = ?)
                OR (requester_id = ? AND addressee_id = ?)`
        )
        .get(userId, otherId, otherId, userId);
}

// Every user the given one is actually friends with (pending doesn't count).
function friendIdsOf(userId) {
    return db
        .prepare(
            `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS friend_id
             FROM friendships
             WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
        )
        .all(userId, userId, userId)
        .map((row) => row.friend_id);
}

function areFriends(userId, otherId) {
    const row = friendRow(userId, otherId);
    return Boolean(row && row.status === "accepted");
}

// What one user is to another, from `userId`'s point of view. The UI needs the
// direction of a pending request (can I accept it, or am I waiting?), not just
// that one exists.
function relationshipTo(userId, otherId) {
    if (userId === otherId) return "self";
    const row = friendRow(userId, otherId);
    if (!row) return "none";
    if (row.status === "accepted") return "friends";
    return row.requester_id === userId ? "request_sent" : "request_received";
}

function publicUser(user) {
    return { id: user.id, username: user.username };
}

function findUser(id) {
    const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(id);
    if (!user) throw new ApiError(404, "User not found");
    return user;
}

// ---- Finding people ----

// Substring match on username so "ada" finds "adalovelace". Email is
// deliberately not searchable and never returned: it would turn the people
// search into a way to harvest addresses.
router.get("/users/search", requireAuth, (req, res) => {
    const query = String(req.query.q || "").trim();
    if (!query) {
        res.json([]);
        return;
    }

    const rows = db
        .prepare(
            `SELECT id, username FROM users
             WHERE id != ? AND username LIKE ? ESCAPE '\\'
             ORDER BY username LIMIT ?`
        )
        .all(req.user.id, `%${escapeLike(query)}%`, MAX_SEARCH_RESULTS);

    res.json(rows.map((user) => ({ ...publicUser(user), relationship: relationshipTo(req.user.id, user.id) })));
});

// A username containing % or _ should match those characters literally rather
// than acting as LIKE wildcards.
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ---- Friends and requests ----

router.get("/friends", requireAuth, (req, res) => {
    const friends = friendIdsOf(req.user.id).map((id) => publicUser(findUser(id)));
    friends.sort((a, b) => a.username.localeCompare(b.username));
    res.json(friends);
});

router.get("/friends/requests", requireAuth, (req, res) => {
    const incoming = db
        .prepare(
            `SELECT f.friendship_id, f.created_at, u.id, u.username
             FROM friendships f JOIN users u ON u.id = f.requester_id
             WHERE f.addressee_id = ? AND f.status = 'pending'
             ORDER BY f.created_at`
        )
        .all(req.user.id);
    const outgoing = db
        .prepare(
            `SELECT f.friendship_id, f.created_at, u.id, u.username
             FROM friendships f JOIN users u ON u.id = f.addressee_id
             WHERE f.requester_id = ? AND f.status = 'pending'
             ORDER BY f.created_at`
        )
        .all(req.user.id);

    const shape = (row) => ({
        friendship_id: row.friendship_id,
        created_at: row.created_at,
        user: { id: row.id, username: row.username },
    });
    res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
});

// Takes a username (what the search returns) rather than an id, so the Friends
// tab can also just let someone type in a name they already know.
router.post("/friends/requests", requireAuth, (req, res) => {
    const username = String(req.body?.username || "").trim();
    if (!username) throw new ApiError(400, "Username cannot be empty");

    const target = db.prepare("SELECT id, username FROM users WHERE username = ?").get(username);
    if (!target) throw new ApiError(404, "User not found");
    if (target.id === req.user.id) throw new ApiError(400, "You can't add yourself as a friend");

    const existing = friendRow(req.user.id, target.id);
    if (existing) {
        if (existing.status === "accepted") throw new ApiError(409, "You're already friends");
        // They asked first and we're now asking back -- that's an accept, not
        // a second pending request in the other direction.
        if (existing.addressee_id === req.user.id) {
            db.prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE friendship_id = ?").run(
                new Date().toISOString(),
                existing.friendship_id
            );
            res.status(200).json({ friendship_id: existing.friendship_id, status: "accepted" });
            return;
        }
        throw new ApiError(409, "Friend request already sent");
    }

    const info = db
        .prepare(
            "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)"
        )
        .run(req.user.id, target.id, new Date().toISOString());

    res.status(201).json({ friendship_id: Number(info.lastInsertRowid), status: "pending" });
});

// 404 rather than 403 for someone else's request, matching ownedConversation
// in conversations.js: don't confirm that an id exists.
function pendingRequestFor(friendshipId, userId) {
    const row = db
        .prepare("SELECT * FROM friendships WHERE friendship_id = ? AND addressee_id = ? AND status = 'pending'")
        .get(friendshipId, userId);
    if (!row) throw new ApiError(404, "Friend request not found");
    return row;
}

router.post("/friends/requests/:id/accept", requireAuth, (req, res) => {
    const request = pendingRequestFor(Number(req.params.id), req.user.id);
    db.prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE friendship_id = ?").run(
        new Date().toISOString(),
        request.friendship_id
    );
    res.json({ ok: true });
});

router.post("/friends/requests/:id/decline", requireAuth, (req, res) => {
    const request = pendingRequestFor(Number(req.params.id), req.user.id);
    db.prepare("DELETE FROM friendships WHERE friendship_id = ?").run(request.friendship_id);
    res.json({ ok: true });
});

// Unfriend, and also how the sender cancels a request they sent: both are just
// "remove the row between us", from either end.
router.delete("/friends/:userId", requireAuth, (req, res) => {
    const row = friendRow(req.user.id, Number(req.params.userId));
    if (!row) throw new ApiError(404, "Not connected to that user");
    db.prepare("DELETE FROM friendships WHERE friendship_id = ?").run(row.friendship_id);
    res.json({ ok: true });
});

module.exports = { router, friendIdsOf, areFriends, relationshipTo };
