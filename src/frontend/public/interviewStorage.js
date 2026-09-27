// Saves an interview through the accounts/conversations API (../conversations.js,
// ../stories.js) -- via storage_api.js, the one place that talks to the API.
//
// Without this the interview page only wrote its result to sessionStorage, so a
// transcript was gone the moment the tab closed and the Story tab never saw the
// interview at all. With it, an interview shows up in the Story tab's
// conversation list and its generated chapter is there to read and publish.
//
// Shape of what gets written is the same one testChat.js uses for a typed
// conversation: one `prompts` row per exchange, with the storyteller's words in
// `content` and the interviewer's question in `response`. `content` has to stay
// on the storyteller's side of the exchange because that is what the server
// treats as the author's own words when a story's text is derived from a
// conversation (see contentFromConversation() in ../stories.js).
//
// Every call here is best-effort: a save that fails logs and reports itself in
// the status line rather than throwing, because the interview still works
// without storage.

const INTERVIEW_CONVERSATION_KEY = "interviewConversationId";

function hasSession() {
    return storageApi.isLoggedIn();
}

function setInterviewStatus(message) {
    const status = document.getElementById("storageStatus");
    if (status) status.textContent = message;
}

// The conversation this interview belongs to, if the URL explicitly names one
// -- which is how the Story tab resumes a recorded interview
// (interview.html?resume=<id>, or the older ?conversation=<id>). Otherwise
// every interview records into a conversation of its own: the id an earlier
// interview left in sessionStorage is deliberately *not* reused, or a second
// interview in the same tab would be appended to the first one's transcript.
// (sessionStorage still gets the new id -- chapter-preview.html reads it to
// lead back to this interview's conversation.)
function requestedInterviewConversationId() {
    const params = new URLSearchParams(window.location.search);
    const id = Number(params.get("resume") || params.get("conversation"));
    return Number.isInteger(id) && id > 0 ? id : null;
}

// The mode and answer method this interview was started with; stored on the
// conversation so resuming it later brings back the same interviewer.
function currentInterviewSettings() {
    return {
        mode: new URLSearchParams(window.location.search).get("mode") || "Life Period",
        method: sessionStorage.getItem("interviewMethod") || "audio",
    };
}

// Created as soon as the interview session starts (interviewStorage.beginSession,
// called once the first question is on screen), so every interview session is
// logged and listed in the Story tab -- even one that ends before an answer.
// Shared with rememberTurn/saveChapter, which reuse the same conversation.
function ensureInterviewConversation() {
    // Shared rather than just memoized: speech recognition reports one answer as
    // several chunks, so two saves can be in flight at once and must not each
    // create a conversation of their own.
    if (interviewStorage.conversationPromise === null) {
        interviewStorage.conversationPromise = resolveInterviewConversation().catch((err) => {
            // A failure isn't cached -- the next turn gets to try again.
            interviewStorage.conversationPromise = null;
            throw err;
        });
    }
    return interviewStorage.conversationPromise;
}

// The conversation this interview belongs to: one the URL names, otherwise a
// new one.
async function resolveInterviewConversation() {
    const requested = requestedInterviewConversationId();
    if (requested !== null) {
        try {
            // Confirmed before writing into it: a hand-edited id that isn't
            // ours would make every turn 404.
            await storageApi.getConversation(requested);
            interviewStorage.conversationId = requested;
            sessionStorage.setItem(INTERVIEW_CONVERSATION_KEY, String(requested));
            return requested;
        } catch (err) {
            sessionStorage.removeItem(INTERVIEW_CONVERSATION_KEY);
        }
    }

    const { conversation_id } = await storageApi.createConversation({ kind: "interview", ...currentInterviewSettings() });
    interviewStorage.conversationId = conversation_id;
    sessionStorage.setItem(INTERVIEW_CONVERSATION_KEY, String(conversation_id));
    return conversation_id;
}

// Saved turns -> the exchange the interview client replays on resume. Each
// prompts row is one answer (`content`) plus the question it answered
// (`response`), so the question comes first.
function historyFromPrompts(prompts) {
    const history = [];
    for (const prompt of prompts) {
        if (prompt.response) history.push({ role: "assistant", content: prompt.response });
        if (prompt.content) history.push({ role: "user", content: prompt.content });
    }
    return history;
}

// Tells the Story tab (when this page is framed there) that this interview's
// conversation exists, so it can list and highlight it right away.
function announceInterviewConversation(conversationId) {
    if (window.parent === window) return;
    window.parent.postMessage(
        { type: "reellife:interview-logged", conversationId },
        window.location.origin
    );
}

const interviewStorage = {
    conversationId: null,
    conversationPromise: null,

    // Logs this interview session as a conversation of its own the moment it
    // starts (or confirms the resumed one), then announces it to the Story tab.
    // Best-effort like everything here: a failure is reported in the status
    // line, and the first saved turn tries again.
    async beginSession() {
        if (!hasSession()) {
            setInterviewStatus("Not saved — sign in to keep this interview");
            return null;
        }
        try {
            const conversationId = await ensureInterviewConversation();
            console.log(`Interview session logged as conversation #${conversationId}`);
            setInterviewStatus("Saving to your Story tab");
            announceInterviewConversation(conversationId);
            return conversationId;
        } catch (err) {
            console.error("Could not log the interview session:", err);
            setInterviewStatus(`Not saved — ${err.detail || err.message}`);
            return null;
        }
    },

    // Loads a recorded interview so it can be picked up where it stopped:
    // the conversation (for its mode/method) and its saved exchange. Also makes
    // it the conversation every new turn is saved into. null if it can't be
    // loaded, in which case the caller starts a fresh interview instead.
    async loadForResume(conversationId) {
        if (!hasSession()) return null;
        try {
            const [conversation, prompts] = await Promise.all([
                storageApi.getConversation(conversationId),
                storageApi.getPrompts(conversationId),
            ]);
            interviewStorage.conversationId = conversationId;
            interviewStorage.conversationPromise = Promise.resolve(conversationId);
            sessionStorage.setItem(INTERVIEW_CONVERSATION_KEY, String(conversationId));
            return { conversation, history: historyFromPrompts(prompts) };
        } catch (err) {
            console.error("Could not load the interview to resume:", err);
            setInterviewStatus(`Could not resume — ${err.detail || err.message}`);
            return null;
        }
    },

    // One exchange: the answer just given, paired with the question it answered.
    // Called from the client's onTurn hook, so it fires for spoken and typed
    // answers alike.
    async rememberTurn(question, answer) {
        if (!hasSession()) {
            setInterviewStatus("Not saved — sign in to keep this interview");
            return;
        }

        try {
            const conversationId = await ensureInterviewConversation();
            const { prompt_id } = await storageApi.addPrompt(conversationId, { content: answer });
            if (question) await storageApi.addResponse(prompt_id, { response: question });
            console.log(`Interview turn saved to conversation #${conversationId}`);
            setInterviewStatus("Saved to your Story tab");
            // Keeps the Story tab's list current (e.g. if beginSession failed).
            announceInterviewConversation(conversationId);
        } catch (err) {
            console.error("Could not save interview turn:", err);
            setInterviewStatus(`Not saved — ${err.detail || err.message}`);
        }
    },

    // The generated chapter, kept as a private story: the publish dialog is the
    // only place on the server a story's text can live, and private means
    // "only me", so this is a draft the author can edit or unpublish rather
    // than something that shows up in anyone else's feed. A resumed interview
    // already has a chapter; it's rewritten from the full transcript, but keeps
    // whatever visibility the author chose for it.
    async saveChapter(result) {
        if (!hasSession() || !result?.story?.trim()) return null;

        try {
            const conversationId = await ensureInterviewConversation();
            let visibility = "private";
            try {
                const existing = await storageApi.getConversationStory(conversationId);
                if (existing?.visibility) visibility = existing.visibility;
            } catch (err) {
                // No readable chapter yet -- keep it private.
            }
            const story = await storageApi.publishStory({
                conversationId,
                title: result.title || "Untitled chapter",
                content: result.story,
                place: result.location || "",
                timePeriod: result.period || "",
                visibility,
            });
            setInterviewStatus("Chapter saved — edit it in your Story tab");
            return story;
        } catch (err) {
            console.error("Could not save the generated chapter:", err);
            return null;
        }
    },
};
