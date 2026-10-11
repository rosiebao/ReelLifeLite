// /family -- the Family tab's tree. Every query is scoped by req.user.id, so a
// user only ever sees and writes their own family members.
//
// The whole tree is read and written at once (GET /family, PUT /family), which
// matches how public/family.js edits it: each button click produces a new
// complete tree. Saving reconciles against the existing rows by position
// instead of deleting and re-inserting, so member_id stays stable for members
// that didn't move -- anything attached to a member later survives an edit
// elsewhere in the tree.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");

const router = express.Router();

// Generous enough for any real family tree, low enough that a bad request
// can't fill the database.
const MAX_ROWS = 20;
const MAX_MEMBERS_PER_ROW = 20;
const MAX_NAME_LENGTH = 100;
const MAX_PHOTO_LENGTH = 2048;
const DEFAULT_MEMBER_NAME = "Unnamed";
const DEFAULT_MEMBER_PHOTO = "profile.jpg";

// Validates and cleans up a client payload into { rows: [ { members: [...] } ] }.
// Blank names become "Unnamed" (the same fallback the page uses) rather than a
// 400 -- only structurally wrong or oversized input is rejected.
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
            return { name, photo, is_self: Boolean(member?.is_self) };
        });
    });

    // is_self marks the account holder's own node. Exactly one member can be
    // "you", so a tree claiming several is rejected outright.
    const selfCount = parsed.flat().filter((member) => member.is_self).length;
    if (selfCount > 1) throw new ApiError(400, "Only one family member can be marked as you");

    return parsed;
}

// `seeded` is how the page tells "never opened the Family tab" apart from
// "deleted every row on purpose" -- both have no rows, but only the first
// should get the starting layout.
function getFamilyTree(userId) {
    const rows = db
        .prepare("SELECT row_id FROM family_rows WHERE user_id = ? ORDER BY position")
        .all(userId);
    const membersOf = db.prepare(
        "SELECT name, photo, is_self FROM family_members WHERE row_id = ? ORDER BY position"
    );
    const seeded = db.prepare("SELECT 1 FROM family_state WHERE user_id = ?").get(userId);

    return {
        rows: rows.map((row) => ({
            // SQLite has no boolean type, so is_self comes back as 0/1.
            members: membersOf.all(row.row_id).map((member) => ({
                ...member,
                is_self: Boolean(member.is_self),
            })),
        })),
        seeded: Boolean(seeded),
    };
}

// Writes `tree` (already parsed) over whatever the user has now.
function saveFamilyTree(userId, tree) {
    const now = new Date().toISOString();
    const existingRows = db
        .prepare("SELECT row_id FROM family_rows WHERE user_id = ? ORDER BY position")
        .all(userId);

    db.exec("BEGIN");
    try {
        // Any save marks the account as set up, an empty tree included.
        db.prepare("INSERT OR IGNORE INTO family_state (user_id, seeded_at) VALUES (?, ?)").run(userId, now);

        tree.forEach((members, rowIndex) => {
            let rowId = existingRows[rowIndex]?.row_id;
            if (rowId === undefined) {
                rowId = Number(
                    db
                        .prepare("INSERT INTO family_rows (user_id, position, created_at) VALUES (?, ?, ?)")
                        .run(userId, rowIndex, now).lastInsertRowid
                );
            } else {
                db.prepare("UPDATE family_rows SET position = ? WHERE row_id = ?").run(rowIndex, rowId);
            }
            saveRowMembers(rowId, members, now);
        });

        // Rows the new tree no longer has. family_members cascades.
        for (const row of existingRows.slice(tree.length)) {
            db.prepare("DELETE FROM family_rows WHERE row_id = ?").run(row.row_id);
        }
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}

function saveRowMembers(rowId, members, now) {
    const existing = db
        .prepare("SELECT member_id FROM family_members WHERE row_id = ? ORDER BY position")
        .all(rowId);

    members.forEach((member, position) => {
        const memberId = existing[position]?.member_id;
        if (memberId === undefined) {
            db.prepare(
                "INSERT INTO family_members (row_id, position, name, photo, is_self, created_at) VALUES (?, ?, ?, ?, ?, ?)"
            ).run(rowId, position, member.name, member.photo, Number(member.is_self), now);
        } else {
            db.prepare(
                "UPDATE family_members SET position = ?, name = ?, photo = ?, is_self = ? WHERE member_id = ?"
            ).run(position, member.name, member.photo, Number(member.is_self), memberId);
        }
    });

    for (const member of existing.slice(members.length)) {
        db.prepare("DELETE FROM family_members WHERE member_id = ?").run(member.member_id);
    }
}

// A user who has never opened the Family tab gets { rows: [], seeded: false };
// the page then seeds itself from the starter tree in index.html and saves
// that back. Once seeded, an empty tree stays empty.
router.get("/family", requireAuth, (req, res) => {
    res.json(getFamilyTree(req.user.id));
});

router.put("/family", requireAuth, (req, res) => {
    saveFamilyTree(req.user.id, parseFamilyTree(req.body));
    res.json(getFamilyTree(req.user.id));
});

module.exports = { router, getFamilyTree };
