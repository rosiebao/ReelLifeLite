// /drafts -- the History tab: every story "Write my story" has written for the
// caller (they're saved by ./interview.js as they're drafted). Read-only apart
// from deleting one; a draft is reused by opening it in the publish dialog.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");

const router = express.Router();

// The conversation's mode comes along so the list can say which interview a
// draft was written from. Newest first; draft_id breaks ties within a second.
router.get("/drafts", requireAuth, (req, res) => {
    const drafts = db
        .prepare(
            `SELECT d.draft_id, d.conversation_id, d.content, d.created_at, c.interview_mode
             FROM story_drafts d
             JOIN conversation c ON c.conversation_id = d.conversation_id
             WHERE d.user_id = ?
             ORDER BY d.created_at DESC, d.draft_id DESC`
        )
        .all(req.user.id);
    res.json(drafts);
});

// 404 rather than 403 for someone else's draft, as with conversations.
router.delete("/drafts/:id", requireAuth, (req, res) => {
    const info = db
        .prepare("DELETE FROM story_drafts WHERE draft_id = ? AND user_id = ?")
        .run(Number(req.params.id), req.user.id);
    if (info.changes === 0) throw new ApiError(404, "Draft not found");
    res.json({ ok: true });
});

module.exports = { router };
