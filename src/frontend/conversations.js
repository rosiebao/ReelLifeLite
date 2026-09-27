// /conversations, /prompts -- mirrors ../database/app/routers/conversations.py.
const express = require("express");
const fs = require("node:fs");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { transcriptPath, appendTranscript, saveMedia } = require("./storage");

const router = express.Router();

// 404 rather than 403 so we don't reveal that the id exists.
function ownedConversation(conversationId, userId) {
    const conversation = db
        .prepare("SELECT * FROM conversation WHERE conversation_id = ? AND user_id = ?")
        .get(conversationId, userId);
    if (!conversation) throw new ApiError(404, "Conversation not found");
    return conversation;
}

const CONVERSATION_KINDS = ["chat", "interview"];
const MAX_INTERVIEW_MODE_LENGTH = 50;
const MAX_INTERVIEW_METHOD_LENGTH = 20;

function parseOptionalText(value, { field, max }) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > max) throw new ApiError(400, `${field} is too long (max ${max} characters)`);
    return text;
}

// Body is optional: no body (or {kind: "chat"}) is a plain typed conversation.
// {kind: "interview", mode, method} records a Claude interview; it gets the
// next interview number for this user, so the list reads "Interview #1, #2...".
router.post("/conversations", requireAuth, (req, res) => {
    const kind = req.body?.kind === undefined || req.body?.kind === null ? "chat" : String(req.body.kind);
    if (!CONVERSATION_KINDS.includes(kind)) {
        throw new ApiError(400, `Conversation kind must be one of: ${CONVERSATION_KINDS.join(", ")}`);
    }

    let interviewNumber = null;
    let interviewMode = null;
    let interviewMethod = null;
    if (kind === "interview") {
        interviewMode = parseOptionalText(req.body?.mode, { field: "Interview mode", max: MAX_INTERVIEW_MODE_LENGTH });
        interviewMethod = parseOptionalText(req.body?.method, {
            field: "Interview method",
            max: MAX_INTERVIEW_METHOD_LENGTH,
        });
        // Computed and inserted in one synchronous step, so two requests can't
        // both be handed the same number.
        interviewNumber =
            db
                .prepare("SELECT COALESCE(MAX(interview_number), 0) + 1 AS next FROM conversation WHERE user_id = ?")
                .get(req.user.id).next;
    }

    const info = db
        .prepare(
            `INSERT INTO conversation (user_id, conversation, creation_date, cost, kind, interview_number,
             interview_mode, interview_method) VALUES (?, NULL, ?, 0, ?, ?, ?, ?)`
        )
        .run(req.user.id, new Date().toISOString(), kind, interviewNumber, interviewMode, interviewMethod);
    const conversationId = Number(info.lastInsertRowid);

    const path = transcriptPath(conversationId);
    fs.writeFileSync(path, "", "utf8");
    db.prepare("UPDATE conversation SET conversation = ? WHERE conversation_id = ?").run(path, conversationId);

    res.status(201).json({ conversation_id: conversationId, kind, interview_number: interviewNumber });
});

router.get("/conversations", requireAuth, (req, res) => {
    const rows = db
        .prepare("SELECT * FROM conversation WHERE user_id = ? ORDER BY creation_date")
        .all(req.user.id);
    res.json(rows);
});

router.get("/conversations/:id", requireAuth, (req, res) => {
    res.json(ownedConversation(Number(req.params.id), req.user.id));
});

router.get("/conversations/:id/prompts", requireAuth, (req, res) => {
    ownedConversation(Number(req.params.id), req.user.id);
    const rows = db
        .prepare("SELECT * FROM prompts WHERE conversation_id = ? ORDER BY prompt_time")
        .all(Number(req.params.id));
    res.json(rows);
});

router.post("/conversations/:id/prompts", requireAuth, (req, res) => {
    const conversationId = Number(req.params.id);
    ownedConversation(conversationId, req.user.id);

    const content = req.body?.content;
    if (!content) throw new ApiError(400, "Prompt content cannot be empty");

    let inputMediaPath = null;
    if (req.body?.input_media_base64) {
        inputMediaPath = saveMedia(conversationId, req.body.input_media_filename || "input", req.body.input_media_base64);
    }

    const info = db
        .prepare(
            "INSERT INTO prompts (conversation_id, prompt_time, content, response, input_media, output_media) VALUES (?, ?, ?, NULL, ?, NULL)"
        )
        .run(conversationId, new Date().toISOString(), content, inputMediaPath);

    appendTranscript(conversationId, `[${new Date().toISOString()}] USER: ${content}`);
    res.status(201).json({ prompt_id: Number(info.lastInsertRowid) });
});

router.post("/prompts/:id/response", requireAuth, (req, res) => {
    const promptId = Number(req.params.id);
    const prompt = db.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId);
    if (!prompt) throw new ApiError(404, "Prompt not found");
    ownedConversation(prompt.conversation_id, req.user.id);

    const response = req.body?.response;
    if (!response) throw new ApiError(400, "Response content cannot be empty");

    let outputMediaPath = null;
    if (req.body?.output_media_base64) {
        outputMediaPath = saveMedia(
            prompt.conversation_id,
            req.body.output_media_filename || "output",
            req.body.output_media_base64
        );
    }

    db.prepare("UPDATE prompts SET response = ?, output_media = ? WHERE prompt_id = ?").run(
        response,
        outputMediaPath,
        promptId
    );
    appendTranscript(prompt.conversation_id, `[${new Date().toISOString()}] AI: ${response}`);

    const cost = Number(req.body?.cost || 0);
    db.prepare("UPDATE conversation SET cost = cost + ? WHERE conversation_id = ?").run(cost, prompt.conversation_id);

    res.json({ ok: true });
});

module.exports = { router };
