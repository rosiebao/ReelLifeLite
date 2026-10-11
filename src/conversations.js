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

function promptsOf(conversationId) {
    return db
        .prepare("SELECT * FROM prompts WHERE conversation_id = ? ORDER BY prompt_time, prompt_id")
        .all(conversationId);
}

// Shared with ../interview.js, whose answers are prompts like any other.
function insertPrompt(conversationId, { content, inputMediaFilename, inputMediaBase64 } = {}) {
    let inputMediaPath = null;
    if (inputMediaBase64) {
        inputMediaPath = saveMedia(conversationId, inputMediaFilename || "input", inputMediaBase64);
    }

    const info = db
        .prepare(
            "INSERT INTO prompts (conversation_id, prompt_time, content, response, input_media, output_media) VALUES (?, ?, ?, NULL, ?, NULL)"
        )
        .run(conversationId, new Date().toISOString(), content, inputMediaPath);

    appendTranscript(conversationId, `[${new Date().toISOString()}] USER: ${content}`);
    return Number(info.lastInsertRowid);
}

function saveResponse(prompt, { response, outputMediaFilename, outputMediaBase64, cost } = {}) {
    let outputMediaPath = null;
    if (outputMediaBase64) {
        outputMediaPath = saveMedia(prompt.conversation_id, outputMediaFilename || "output", outputMediaBase64);
    }

    db.prepare("UPDATE prompts SET response = ?, output_media = ? WHERE prompt_id = ?").run(
        response,
        outputMediaPath,
        prompt.prompt_id
    );
    appendTranscript(prompt.conversation_id, `[${new Date().toISOString()}] AI: ${response}`);

    db.prepare("UPDATE conversation SET cost = cost + ? WHERE conversation_id = ?").run(
        Number(cost || 0),
        prompt.conversation_id
    );
}

router.post("/conversations", requireAuth, (req, res) => {
    const info = db
        .prepare("INSERT INTO conversation (user_id, conversation, creation_date, cost) VALUES (?, NULL, ?, 0)")
        .run(req.user.id, new Date().toISOString());
    const conversationId = Number(info.lastInsertRowid);

    const path = transcriptPath(conversationId);
    fs.writeFileSync(path, "", "utf8");
    db.prepare("UPDATE conversation SET conversation = ? WHERE conversation_id = ?").run(path, conversationId);

    res.status(201).json({ conversation_id: conversationId });
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
    res.json(promptsOf(Number(req.params.id)));
});

router.post("/conversations/:id/prompts", requireAuth, (req, res) => {
    const conversationId = Number(req.params.id);
    ownedConversation(conversationId, req.user.id);

    const content = req.body?.content;
    if (!content) throw new ApiError(400, "Prompt content cannot be empty");

    const promptId = insertPrompt(conversationId, {
        content,
        inputMediaFilename: req.body?.input_media_filename,
        inputMediaBase64: req.body?.input_media_base64,
    });
    res.status(201).json({ prompt_id: promptId });
});

router.post("/prompts/:id/response", requireAuth, (req, res) => {
    const promptId = Number(req.params.id);
    const prompt = db.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId);
    if (!prompt) throw new ApiError(404, "Prompt not found");
    ownedConversation(prompt.conversation_id, req.user.id);

    const response = req.body?.response;
    if (!response) throw new ApiError(400, "Response content cannot be empty");

    saveResponse(prompt, {
        response,
        outputMediaFilename: req.body?.output_media_filename,
        outputMediaBase64: req.body?.output_media_base64,
        cost: req.body?.cost,
    });
    res.json({ ok: true });
});

module.exports = { router, ownedConversation, promptsOf, insertPrompt, saveResponse };
