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
const { limits: storyLimits } = require("./stories");

const router = express.Router();

const MAX_ANSWER_LENGTH = 20000;

// Cut to `max` characters, at a word break where there is one, so a drafted
// field always fits the publish form.
function fitText(value, max) {
    const text = String(value ?? "").trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

// What Claude drafted for the publish form, made safe to publish as-is: every
// field within its limit, and tags the way ./stories.js stores them (no '#',
// no commas, no repeats, at most MAX_TAGS).
function storyDetails(drafted) {
    const tags = [];
    for (const raw of drafted.tags || []) {
        const tag = String(raw).replace(/^#+/, "").replace(/,/g, " ").trim();
        if (tag && tag.length <= storyLimits.tag && !tags.includes(tag)) tags.push(tag);
    }
    return {
        title: fitText(drafted.title, storyLimits.title),
        summary: fitText(drafted.summary, storyLimits.summary),
        place: fitText(drafted.place, storyLimits.place),
        time_period: fitText(drafted.time_period, storyLimits.time_period),
        tags: tags.slice(0, storyLimits.tags),
    };
}

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

// A draft for the publish dialog to fill in: the story Claude wrote from the
// interview, plus a title, summary, place, time period and tags for the form.
// The draft itself is kept in story_drafts (see ./drafts.js)
// so closing the dialog doesn't lose it; what the user edits there is only
// stored by publishing.
//
// This is also how an interview ends ("End" on the Story tab): an `answer`
// still in the box is saved as the last prompt first, so it's part of the
// story -- without asking the interviewer for a question nobody will see. The
// answer is kept even if writing the story then fails.
router.post("/conversations/:id/interview/story", requireAuth, async (req, res) => {
    const conversationId = Number(req.params.id);
    const conversation = ownedConversation(conversationId, req.user.id);

    const answer = String(req.body?.answer ?? "").trim();
    if (answer.length > MAX_ANSWER_LENGTH) {
        throw new ApiError(400, `Answer is too long (max ${MAX_ANSWER_LENGTH} characters)`);
    }
    if (answer) insertPrompt(conversationId, { content: answer });

    const prompts = promptsOf(conversationId);
    if (prompts.length === 0) throw new ApiError(400, "Answer a question or two first");

    const drafted = await ask(
        () =>
            interviewer.draftStory(conversation.opening_question, prompts, {
                recordedAt: conversation.creation_date,
                mode: conversation.interview_mode,
            }),
        "Couldn't write your story just now. Try again."
    );
    const story = fitText(drafted.story, storyLimits.content);
    const details = storyDetails(drafted);

    const createdAt = new Date().toISOString();
    const info = db
        .prepare(
            "INSERT INTO story_drafts (user_id, conversation_id, content, details, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(req.user.id, conversationId, story, JSON.stringify(details), createdAt);
    appendTranscript(conversationId, `[${new Date().toISOString()}] AI (story written, draft ${info.lastInsertRowid})`);
    res.json({
        story,
        ...details,
        // false when the interview AI is switched off and `story` is just the
        // answers, so the Story tab can say so instead of looking written.
        ai: drafted.ai === true,
        draft_id: Number(info.lastInsertRowid),
        created_at: createdAt,
    });
});

module.exports = { router };
