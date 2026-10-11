// /conversations/{id}/interview/* -- the Story tab's AI interviewer, on top of
// the ordinary conversation/prompt storage in conversations.js.
//
// An interview is stored as a normal conversation. The interviewer's first
// question lives on the conversation (opening_question, since no prompt comes
// before it); after that, each prompt row is one answer (`content`) plus the
// question the interviewer asked next (`response`). That keeps `content` the
// user's own words, which is what ../stories.js publishes by default.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { requireAuth } = require("./auth");
const { appendTranscript } = require("./storage");
const { ownedConversation, promptsOf, insertPrompt, saveResponse } = require("./conversations");
const interviewer = require("./interviewer");

const router = express.Router();

const MAX_ANSWER_LENGTH = 20000;

// Anything the interviewer can't do becomes a 502 (or 503 for "try again in a
// moment") with a message fit for the chat, and the details go to the log.
async function ask(generate, failure = "The interviewer couldn't come up with a question. Try again.") {
    try {
        return await generate();
    } catch (err) {
        if (!(err instanceof interviewer.InterviewerError)) throw err;
        console.error(err);
        if (err.retryable) throw new ApiError(503, "The interviewer is busy right now. Try again in a moment.");
        throw new ApiError(502, failure);
    }
}

function modeOf(conversation) {
    return interviewer.parseMode(conversation.interview_mode) || interviewer.DEFAULT_MODE;
}

router.post("/conversations/:id/interview/start", requireAuth, async (req, res) => {
    const conversationId = Number(req.params.id);
    const conversation = ownedConversation(conversationId, req.user.id);

    // Starting twice (a double click, a retry after a slow response) hands back
    // the question already asked instead of replacing it.
    if (conversation.opening_question) {
        res.json({ mode: modeOf(conversation), question: conversation.opening_question });
        return;
    }
    if (promptsOf(conversationId).length > 0) {
        throw new ApiError(409, "This conversation has already started");
    }

    const requested = req.body?.mode ?? interviewer.DEFAULT_MODE;
    const mode = interviewer.parseMode(requested);
    if (!mode) {
        throw new ApiError(400, `Mode must be one of: ${Object.keys(interviewer.MODES).join(", ")}`);
    }

    const question = await ask(() => interviewer.openingQuestion(mode));

    // Only the first of two overlapping starts gets to set the question.
    const info = db
        .prepare(
            "UPDATE conversation SET interview_mode = ?, opening_question = ? WHERE conversation_id = ? AND opening_question IS NULL"
        )
        .run(mode, question, conversationId);
    if (info.changes > 0) appendTranscript(conversationId, `[${new Date().toISOString()}] AI: ${question}`);

    const saved = ownedConversation(conversationId, req.user.id);
    res.status(201).json({ mode: modeOf(saved), question: saved.opening_question });
});

// Saves the answer first, so a failed question never loses what the user said.
router.post("/conversations/:id/interview/answer", requireAuth, async (req, res) => {
    const conversationId = Number(req.params.id);
    const conversation = ownedConversation(conversationId, req.user.id);

    const content = String(req.body?.content ?? "").trim();
    if (!content) throw new ApiError(400, "Answer cannot be empty");
    if (content.length > MAX_ANSWER_LENGTH) {
        throw new ApiError(400, `Answer is too long (max ${MAX_ANSWER_LENGTH} characters)`);
    }

    const promptId = insertPrompt(conversationId, { content });
    const prompts = promptsOf(conversationId);
    const question = await ask(() =>
        interviewer.nextQuestion(modeOf(conversation), conversation.opening_question, prompts)
    );

    saveResponse(
        prompts.find((prompt) => prompt.prompt_id === promptId),
        { response: question }
    );
    res.status(201).json({ prompt_id: promptId, question });
});

// Swaps the latest question for a different one. If the latest answer never
// got a question (the interviewer failed), this is also how to retry it.
router.post("/conversations/:id/interview/skip", requireAuth, async (req, res) => {
    const conversationId = Number(req.params.id);
    const conversation = ownedConversation(conversationId, req.user.id);
    const mode = modeOf(conversation);
    const prompts = promptsOf(conversationId);
    const latest = prompts.at(-1);

    // The answer is still waiting on its question: just ask the next one.
    if (latest && latest.response === null) {
        const question = await ask(() => interviewer.nextQuestion(mode, conversation.opening_question, prompts));
        saveResponse(latest, { response: question });
        res.json({ question });
        return;
    }

    const skipped = latest ? latest.response : conversation.opening_question;
    if (!skipped) throw new ApiError(409, "Start the interview first");

    const question = await ask(() =>
        interviewer.replacementQuestion(mode, conversation.opening_question, prompts, skipped)
    );
    if (latest) {
        db.prepare("UPDATE prompts SET response = ? WHERE prompt_id = ?").run(question, latest.prompt_id);
    } else {
        db.prepare("UPDATE conversation SET opening_question = ? WHERE conversation_id = ?").run(
            question,
            conversationId
        );
    }
    appendTranscript(conversationId, `[${new Date().toISOString()}] AI (replacing a skipped question): ${question}`);
    res.json({ question });
});

// A draft for the publish dialog to fill in. The draft itself is kept in
// story_drafts (the History tab, see ./drafts.js) so closing the dialog
// doesn't lose it; what the user edits there is only stored by publishing.
router.post("/conversations/:id/interview/story", requireAuth, async (req, res) => {
    const conversationId = Number(req.params.id);
    const conversation = ownedConversation(conversationId, req.user.id);
    const prompts = promptsOf(conversationId);
    if (prompts.length === 0) throw new ApiError(400, "Answer a question or two first");

    const story = await ask(
        () => interviewer.draftStory(conversation.opening_question, prompts),
        "Couldn't write your story just now. Try again."
    );

    const createdAt = new Date().toISOString();
    const info = db
        .prepare("INSERT INTO story_drafts (user_id, conversation_id, content, created_at) VALUES (?, ?, ?, ?)")
        .run(req.user.id, conversationId, story, createdAt);
    res.json({ story, draft_id: Number(info.lastInsertRowid), created_at: createdAt });
});

module.exports = { router };
