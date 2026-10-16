// /family -- the Family tab's tree. Every query is scoped by req.user.id, so a
// user only ever sees and writes their own family members.
//
// The whole tree is read and written at once (GET /family, PUT /family), which
// matches how public/family.js edits it: each change produces a new complete
// tree. Members carry their member_id, so a save updates the same row even
// when a member moves to another generation, and whatever hangs off a member
// (an invitation, the account they're linked to) survives edits elsewhere. A
// member sent without an id falls back to the one at the same place in the
// tree, which is how trees were matched before ids were sent.
//
// Invitations: POST /family/members/:id/invite gives a member a secret token,
// which the page turns into a link (index.html?invite=<token>). Whoever opens
// it signed in can accept it, which links their account to that member and
// makes the two of you friends.
const express = require("express");
const crypto = require("node:crypto");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { friendRow, areFriends } = require("./friends");
const { photoUrl } = require("./profile");

const router = express.Router();

// Everyone the user is family with on ReelLife: the accounts linked into
// their own tree (an accepted invitation, or a friend added with "Add
// member"), and the owners of trees they're linked into themselves. It goes
// both ways, so someone who accepted your invitation reads the stories you
// share with family, and you read theirs. Used by ../stories.js for the
// "Family" audience.
function familyIdsOf(userId) {
    return db
        .prepare(
            `SELECT m.linked_user_id AS family_id
             FROM family_members m JOIN family_rows r ON r.row_id = m.row_id
             WHERE r.user_id = ? AND m.linked_user_id IS NOT NULL AND m.linked_user_id <> ?
             UNION
             SELECT r.user_id AS family_id
             FROM family_members m JOIN family_rows r ON r.row_id = m.row_id
             WHERE m.linked_user_id = ? AND r.user_id <> ?`
        )
        .all(userId, userId, userId, userId)
        .map((row) => row.family_id);
}

// Generous enough for any real family tree, low enough that a bad request
// can't fill the database.
const MAX_ROWS = 20;
const MAX_MEMBERS_PER_ROW = 20;
const MAX_NAME_LENGTH = 100;
const MAX_PHOTO_LENGTH = 2048;
const MAX_RELATIONSHIP_LENGTH = 50;
const MAX_EMAIL_LENGTH = 254;
const DEFAULT_MEMBER_NAME = "Unnamed";
const DEFAULT_MEMBER_PHOTO = "profile.jpg";

function optionalText(value, { field, max }) {
    const text = String(value ?? "").trim();
    if (text.length > max) throw new ApiError(400, `${field} is too long`);
    return text || null;
}

function optionalEmail(value) {
    const email = optionalText(value, { field: "Email", max: MAX_EMAIL_LENGTH });
    if (email === null) return null;
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ApiError(400, "Invalid email address");
    return email.toLowerCase();
}

function optionalId(value) {
    if (value === undefined || value === null || value === "") return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "Invalid id");
    return id;
}

// Validates and cleans up a client payload into a list of rows, each a list of
// members. Blank names become "Unnamed" (the same fallback the page uses)
// rather than a 400 -- only structurally wrong or oversized input is rejected.
function parseFamilyTree(body) {
    const rows = body?.rows;
    if (!Array.isArray(rows)) throw new ApiError(400, "Body must be { rows: [...] }");
    if (rows.length > MAX_ROWS) throw new ApiError(400, `A family tree can have at most ${MAX_ROWS} rows`);

    const parsed = rows.map((row) => {
        const members = row?.members;
        if (!Array.isArray(members)) throw new ApiError(400, "Each row must be { members: [...] }");
        if (members.length > MAX_MEMBERS_PER_ROW) {
            throw new ApiError(400, `A row can have at most ${MAX_MEMBERS_PER_ROW} members`);
        }

        return members.map((member) => {
            const name = String(member?.name ?? "").trim() || DEFAULT_MEMBER_NAME;
            const photo = String(member?.photo ?? "").trim() || DEFAULT_MEMBER_PHOTO;
            if (name.length > MAX_NAME_LENGTH) throw new ApiError(400, "Name is too long");
            if (photo.length > MAX_PHOTO_LENGTH) throw new ApiError(400, "Photo is too long");
            return {
                member_id: optionalId(member?.member_id),
                name,
                photo,
                is_self: Boolean(member?.is_self),
                relationship: optionalText(member?.relationship, {
                    field: "Relationship",
                    max: MAX_RELATIONSHIP_LENGTH,
                }),
                email: optionalEmail(member?.email),
                linked_user_id: optionalId(member?.linked_user_id),
            };
        });
    });

    // is_self marks the account holder's own node. Exactly one member can be
    // "you", so a tree claiming several is rejected outright.
    const all = parsed.flat();
    if (all.filter((member) => member.is_self).length > 1) {
        throw new ApiError(400, "Only one family member can be marked as you");
    }
    const ids = all.map((member) => member.member_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new ApiError(400, "A family member appears twice");

    return parsed;
}

// ---- Reading ----

function memberStatus(member) {
    if (member.is_self) return "self";
    if (member.linked_user_id) return "joined";
    if (member.invite_token) return "invited";
    return "not_invited";
}

// The photo to draw: yours for your own node, the linked account's for someone
// on ReelLife (when they have one), otherwise whatever the tree stored. The
// invite token itself never goes out here -- only POST .../invite hands it to
// the tree's owner.
function memberJson(member, owner) {
    const accountPhoto = member.is_self ? owner?.photo : member.linked_photo;
    return {
        member_id: member.member_id,
        name: member.name,
        photo: member.photo,
        photo_url: photoUrl(accountPhoto) || member.photo || DEFAULT_MEMBER_PHOTO,
        is_self: Boolean(member.is_self),
        relationship: member.relationship || "",
        email: member.email || "",
        status: memberStatus(member),
        invited_at: member.invited_at || null,
        linked_user:
            member.linked_user_id && !member.is_self
                ? { id: member.linked_user_id, username: member.linked_username }
                : null,
    };
}

const MEMBER_SELECT = `
    SELECT m.*, u.username AS linked_username, u.photo AS linked_photo
    FROM family_members m
    LEFT JOIN users u ON u.id = m.linked_user_id`;

// `seeded` is how the page tells "never opened the Family tab" apart from
// "deleted every row on purpose" -- both have no rows, but only the first
// should get the starting layout.
function getFamilyTree(userId) {
    const owner = db.prepare("SELECT photo FROM users WHERE id = ?").get(userId);
    const rows = db
        .prepare("SELECT row_id FROM family_rows WHERE user_id = ? ORDER BY position")
        .all(userId);
    const membersOf = db.prepare(`${MEMBER_SELECT} WHERE m.row_id = ? ORDER BY m.position`);
    const seeded = db.prepare("SELECT 1 FROM family_state WHERE user_id = ?").get(userId);

    return {
        rows: rows.map((row) => ({
            members: membersOf.all(row.row_id).map((member) => memberJson(member, owner)),
        })),
        seeded: Boolean(seeded),
    };
}

// One member of the caller's tree, or a 404 -- someone else's member_id looks
// exactly like one that doesn't exist.
function ownedMember(userId, memberId) {
    const member = db
        .prepare(
            `${MEMBER_SELECT} JOIN family_rows r ON r.row_id = m.row_id
             WHERE m.member_id = ? AND r.user_id = ?`
        )
        .get(memberId, userId);
    if (!member) throw new ApiError(404, "Family member not found");
    return member;
}

// ---- Saving ----

function existingMembersOf(userId) {
    return db
        .prepare(
            `SELECT m.member_id, m.linked_user_id, r.position AS row_position, m.position
             FROM family_members m JOIN family_rows r ON r.row_id = m.row_id
             WHERE r.user_id = ?`
        )
        .all(userId);
}

// Pairs every incoming member with the existing one it updates (or none, for
// a new member), and checks each account link the tree asks for.
function matchMembers(userId, tree) {
    const existing = existingMembersOf(userId);
    const byId = new Map(existing.map((member) => [member.member_id, member]));

    // Explicit ids first, so a position fallback can't take a member that is
    // claimed by id somewhere else in the tree.
    const claimed = new Set();
    for (const member of tree.flat()) {
        if (member.member_id === null) continue;
        if (!byId.has(member.member_id)) throw new ApiError(400, "That family member isn't in your tree");
        claimed.add(member.member_id);
    }

    const linked = new Set();
    return tree.map((members, rowIndex) =>
        members.map((member, position) => {
            let current = member.member_id !== null ? byId.get(member.member_id) : null;
            if (!current) {
                current = existing.find(
                    (candidate) =>
                        candidate.row_position === rowIndex &&
                        candidate.position === position &&
                        !claimed.has(candidate.member_id)
                );
                if (current) claimed.add(current.member_id);
            }

            // Your own node is you, so it is never linked to an account.
            // Anyone else can only be newly linked to a friend; an existing
            // link (an accepted invitation) can always be kept.
            const linkedUserId = member.is_self ? null : member.linked_user_id;
            if (linkedUserId !== null && linkedUserId !== current?.linked_user_id) {
                if (linkedUserId === userId) throw new ApiError(400, "You're already in your tree");
                if (!areFriends(userId, linkedUserId)) {
                    throw new ApiError(400, "Only your friends can be added from ReelLife");
                }
            }
            if (linkedUserId !== null) {
                if (linked.has(linkedUserId)) throw new ApiError(400, "That person is already in your tree");
                linked.add(linkedUserId);
            }

            return { ...member, member_id: current?.member_id ?? null, linked_user_id: linkedUserId };
        })
    );
}

// Writes `tree` (already parsed) over whatever the user has now.
function saveFamilyTree(userId, tree) {
    const now = new Date().toISOString();
    const matched = matchMembers(userId, tree);
    const existingRows = db
        .prepare("SELECT row_id FROM family_rows WHERE user_id = ? ORDER BY position")
        .all(userId);
    const existingIds = existingMembersOf(userId).map((member) => member.member_id);

    db.exec("BEGIN");
    try {
        // Any save marks the account as set up, an empty tree included.
        db.prepare("INSERT OR IGNORE INTO family_state (user_id, seeded_at) VALUES (?, ?)").run(userId, now);

        const rowIds = matched.map((members, rowIndex) => {
            const rowId = existingRows[rowIndex]?.row_id;
            if (rowId === undefined) {
                return Number(
                    db
                        .prepare("INSERT INTO family_rows (user_id, position, created_at) VALUES (?, ?, ?)")
                        .run(userId, rowIndex, now).lastInsertRowid
                );
            }
            db.prepare("UPDATE family_rows SET position = ? WHERE row_id = ?").run(rowIndex, rowId);
            return rowId;
        });

        const kept = new Set();
        matched.forEach((members, rowIndex) => {
            members.forEach((member, position) => {
                const values = [
                    rowIds[rowIndex],
                    position,
                    member.name,
                    member.photo,
                    Number(member.is_self),
                    member.relationship,
                    member.email,
                    member.linked_user_id,
                ];
                if (member.member_id === null) {
                    db.prepare(
                        `INSERT INTO family_members
                         (row_id, position, name, photo, is_self, relationship, email, linked_user_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(...values, now);
                    return;
                }
                db.prepare(
                    `UPDATE family_members
                     SET row_id = ?, position = ?, name = ?, photo = ?, is_self = ?,
                         relationship = ?, email = ?, linked_user_id = ?
                     WHERE member_id = ?`
                ).run(...values, member.member_id);
                kept.add(member.member_id);
            });
        });

        // Members the new tree no longer has (their invitations go with
        // them), then rows past the end of it.
        for (const memberId of existingIds) {
            if (!kept.has(memberId)) db.prepare("DELETE FROM family_members WHERE member_id = ?").run(memberId);
        }
        for (const row of existingRows.slice(matched.length)) {
            db.prepare("DELETE FROM family_rows WHERE row_id = ?").run(row.row_id);
        }
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}

// ---- Invitations ----

// The invitation behind a link, with who sent it. 404 for a link that never
// existed, was already accepted, or whose member has since been removed.
function invitationFor(token) {
    const invite = db
        .prepare(
            `SELECT m.member_id, m.name, m.relationship, m.linked_user_id, r.user_id AS owner_id,
                    u.username AS owner_username, u.first_name AS owner_first_name,
                    u.last_name AS owner_last_name, u.photo AS owner_photo
             FROM family_members m
             JOIN family_rows r ON r.row_id = m.row_id
             JOIN users u ON u.id = r.user_id
             WHERE m.invite_token = ?`
        )
        .get(String(token || ""));
    if (!invite) throw new ApiError(404, "This invitation link isn't valid any more");
    return invite;
}

function invitationJson(invite) {
    const ownerName = [invite.owner_first_name, invite.owner_last_name].filter(Boolean).join(" ");
    return {
        from: {
            id: invite.owner_id,
            username: invite.owner_username,
            name: ownerName || invite.owner_username,
            photo_url: photoUrl(invite.owner_photo),
        },
        member: { name: invite.name, relationship: invite.relationship || "" },
    };
}

// Makes the two accounts friends, whatever state they were in before.
function befriend(userId, otherId, now) {
    const row = friendRow(userId, otherId);
    if (!row) {
        db.prepare(
            `INSERT INTO friendships (requester_id, addressee_id, status, created_at, responded_at)
             VALUES (?, ?, 'accepted', ?, ?)`
        ).run(userId, otherId, now, now);
    } else if (row.status !== "accepted") {
        db.prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE friendship_id = ?").run(
            now,
            row.friendship_id
        );
    }
}

// ---- Routes ----

// A user who has never opened the Family tab gets { rows: [], seeded: false };
// the page then seeds itself with its starter tree and saves that back. Once
// seeded, an empty tree stays empty.
router.get("/family", requireAuth, (req, res) => {
    res.json(getFamilyTree(req.user.id));
});

router.put("/family", requireAuth, (req, res) => {
    saveFamilyTree(req.user.id, parseFamilyTree(req.body));
    res.json(getFamilyTree(req.user.id));
});

// Creates the member's invitation, or hands back the one they already have so
// a link sent earlier keeps working. `email` (optional) is saved on the member
// as where it's being sent. -> { token, member }
router.post("/family/members/:id/invite", requireAuth, (req, res) => {
    const member = ownedMember(req.user.id, Number(req.params.id));
    if (member.is_self) throw new ApiError(400, "You can't invite yourself");
    if (member.linked_user_id) throw new ApiError(409, `${member.name} is already on ReelLife`);

    const email = req.body?.email === undefined ? member.email : optionalEmail(req.body.email);
    const token = member.invite_token || crypto.randomBytes(24).toString("base64url");
    db.prepare("UPDATE family_members SET invite_token = ?, invited_at = ?, email = ? WHERE member_id = ?").run(
        token,
        new Date().toISOString(),
        email,
        member.member_id
    );

    const owner = db.prepare("SELECT photo FROM users WHERE id = ?").get(req.user.id);
    res.json({ token, member: memberJson(ownedMember(req.user.id, member.member_id), owner) });
});

// What an invitation link is, so the page can ask before accepting it.
router.get("/family/invites/:token", requireAuth, (req, res) => {
    const invite = invitationFor(req.params.token);
    res.json({ ...invitationJson(invite), own: invite.owner_id === req.user.id });
});

// Accepting links your account to that spot in their tree (so it shows your
// photo and "On ReelLife") and makes the two of you friends. The link is used
// up: the token is cleared, so it can't be accepted twice.
router.post("/family/invites/:token/accept", requireAuth, (req, res) => {
    const invite = invitationFor(req.params.token);
    if (invite.owner_id === req.user.id) throw new ApiError(400, "That's your own invitation");

    const alreadyIn = db
        .prepare(
            `SELECT 1 FROM family_members m JOIN family_rows r ON r.row_id = m.row_id
             WHERE r.user_id = ? AND m.linked_user_id = ?`
        )
        .get(invite.owner_id, req.user.id);
    if (alreadyIn) throw new ApiError(409, `You're already in ${invite.owner_username}'s family tree`);

    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
        db.prepare("UPDATE family_members SET linked_user_id = ?, invite_token = NULL WHERE member_id = ?").run(
            req.user.id,
            invite.member_id
        );
        befriend(req.user.id, invite.owner_id, now);
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
    res.json(invitationJson(invite));
});

module.exports = { router, getFamilyTree, familyIdsOf };
