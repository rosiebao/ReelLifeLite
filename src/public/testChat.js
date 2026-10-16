// "Tell Your Story" tab: an AI interview (ported from the ReelLife repo) on
// top of a conversation list like ai-chat-ui's sidebar. Pick an interview
// mode, start one, and the interviewer (../interview.js) asks a question;
// every answer -- typed, or dictated through voiceInput.js -- is saved and
// answered with the next question. "Skip question" swaps the latest question
// for another, and "End" finishes the interview: the interviewer writes the
// whole interview up as a story and it opens in the publish dialog.
//
// Voice (ported from ReelLife): each question is read aloud (voiceOutput.js)
// and the microphone (voiceInput.js) listens for the answer, switching off
// while a question plays. "Hands-free" sends an answer on its own once the
// storyteller stops talking.
//
// Security: the server checks the session and the conversation's owner on
// every interview call. On top of that this page (sessionWatch.js) keeps
// re-checking the sign-in while the microphone is in play, never opens the
// microphone without a fresh check, and shuts the mic and voice off -- dropping
// words not yet sent -- as soon as the session is gone, the user logs out, the
// tab is hidden, or they leave the Story tab.
//
// Publishing a conversation as a story lives in stories.js, which owns the
// "Published / Not published" status above the message list; this file just
// tells it which conversation is selected (refreshPublishStatus) and hands it
// the story written on End (openPublishModal).

const testState = {
    conversations: [],
    selectedConversationId: null,
    // True while waiting on the interviewer, so a second answer can't be sent
    // before the first one has its question.
    busy: false,
};

const newTestConversationBtn = document.querySelector("#newTestConversationBtn");
const interviewModeSelect = document.querySelector("#interviewModeSelect");
const testConversationList = document.querySelector("#testConversationList");
const testEmptyState = document.querySelector("#testEmptyState");
const testConversationPanel = document.querySelector("#testConversationPanel");
const testMessageList = document.querySelector("#testMessageList");
const testMessageForm = document.querySelector("#testMessageForm");
const testMessageInput = document.querySelector("#testMessageInput");
const testSendBtn = document.querySelector("#testSendBtn");
const micBtn = document.querySelector("#micBtn");
const liveCaption = document.querySelector("#liveCaption");
const micHint = document.querySelector("#micHint");
const voiceToggleBtn = document.querySelector("#voiceToggleBtn");
const handsFreeBtn = document.querySelector("#handsFreeBtn");
const skipQuestionBtn = document.querySelector("#skipQuestionBtn");
const endInterviewBtn = document.querySelector("#endInterviewBtn");
const deleteInterviewBtn = document.querySelector("#deleteInterviewBtn");

function errorText(err) {
    return err.detail || err.message || "Something went wrong";
}

function appendMessage(role, text) {
    const item = document.createElement("div");
    item.className = `message message-${role}`;
    item.textContent = text;
    testMessageList.appendChild(item);
    testMessageList.scrollTop = testMessageList.scrollHeight;
    return item;
}

// An interviewer question: a bubble with a button to hear it (again).
function appendQuestion(text) {
    const item = appendMessage("assistant", text);
    if (speaker) {
        const listen = document.createElement("button");
        listen.type = "button";
        listen.className = "speakButton";
        listen.textContent = "🔊 Listen";
        listen.setAttribute("aria-label", "Read this question aloud");
        listen.addEventListener("click", () => speaker.speak(text, { force: true }));
        item.appendChild(listen);
        testMessageList.scrollTop = testMessageList.scrollHeight;
    }
    return item;
}

function renderTestMessages(conversation, prompts) {
    testMessageList.innerHTML = "";
    // Redrawing history never speaks -- only a newly asked question does.
    if (conversation?.opening_question) appendQuestion(conversation.opening_question);
    for (const prompt of prompts) {
        appendMessage("user", prompt.content);
        if (prompt.response) appendQuestion(prompt.response);
    }
}

function selectedConversation() {
    return testState.conversations.find(
        (conversation) => conversation.conversation_id === testState.selectedConversationId
    );
}

// The interviewer's mode names, as the "Story topic" picker words them.
const TOPIC_LABELS = Object.fromEntries(
    [...interviewModeSelect.options].map((option) => [option.value, option.textContent])
);

function topicLabel(mode) {
    return TOPIC_LABELS[mode] || mode;
}

// "June 18, 2026", as the story reader and both drawers show dates.
function longDate(value) {
    return new Date(value).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// One row in a Story-tab drawer ("Your Stories" / "Your Interviews"): a title
// and a "Topic · date" line, opened by click or Enter. Shared with stories.js
// so the two lists look and behave the same. With `onDelete` the row also gets
// a trash button (its own button, so it never opens the row as well).
function drawerItem({ title, meta, selected = false, onOpen, onDelete, deleteLabel }) {
    const item = document.createElement("li");
    item.className = "drawerItem";
    item.classList.toggle("selected", selected);
    item.tabIndex = 0;

    const heading = document.createElement("span");
    heading.className = "drawerItemTitle";
    heading.textContent = title;
    item.appendChild(heading);

    const line = document.createElement("span");
    line.className = "drawerItemMeta";
    line.textContent = meta;
    item.appendChild(line);

    if (onDelete) {
        item.classList.add("hasDelete");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "drawerItemDelete";
        remove.title = deleteLabel || "Delete";
        remove.setAttribute("aria-label", deleteLabel || "Delete");
        const trash = document.createElement("ion-icon");
        trash.setAttribute("name", "trash-outline");
        trash.setAttribute("aria-hidden", "true");
        remove.appendChild(trash);
        remove.addEventListener("click", (event) => {
            event.stopPropagation();
            onDelete();
        });
        remove.addEventListener("keydown", (event) => event.stopPropagation());
        item.appendChild(remove);
    }

    item.addEventListener("click", onOpen);
    item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target === item) onOpen();
    });
    return item;
}

// An interview has no title of its own: it borrows the title of the story
// published from it (stories.js keeps the list), or goes by its number.
function conversationTitle(conversation) {
    const story = (storyState.myStories || []).find((s) => s.conversation_id === conversation.conversation_id);
    return story ? story.title : `Interview #${conversation.conversation_id}`;
}

function conversationMeta(conversation) {
    const topic = conversation.interview_mode ? topicLabel(conversation.interview_mode) : "Conversation";
    return `${topic} · ${longDate(conversation.creation_date)}`;
}

const interviewCount = document.querySelector("#interviewCount");
const interviewLatest = document.querySelector("#interviewLatest");

// Newest first, like "Your Stories" (the server lists them oldest first).
function renderConversationList() {
    const conversations = [...testState.conversations].reverse();
    testConversationList.innerHTML = "";
    for (const conversation of conversations) {
        testConversationList.appendChild(
            drawerItem({
                title: conversationTitle(conversation),
                meta: conversationMeta(conversation),
                selected: conversation.conversation_id === testState.selectedConversationId,
                onOpen: () => selectTestConversation(conversation.conversation_id),
                onDelete: () => deleteInterview(conversation.conversation_id),
                deleteLabel: `Delete ${conversationTitle(conversation)}`,
            })
        );
    }
    interviewCount.textContent = conversations.length;
    interviewLatest.textContent = conversations.length ? conversationTitle(conversations[0]) : "None yet";
}

async function refreshTestConversations() {
    try {
        testState.conversations = await storageApi.listConversations();
    } catch (err) {
        if (sessionExpired(err)) return;
        testState.conversations = [];
    }
    renderConversationList();
    // Story topics come from their interviews (stories.js, loaded after this).
    if (typeof renderMyStoryDrawer === "function") renderMyStoryDrawer();
}

// keepVoice: redrawing the conversation that is already open (after a skip)
// shouldn't also switch the microphone and the voice off.
async function selectTestConversation(conversationId, { keepVoice = false } = {}) {
    // Words still being dictated belong to the conversation being left, so
    // they are dropped rather than landing in the next one's answer box.
    if (!keepVoice) stopVoice({ discard: true });
    testState.selectedConversationId = conversationId;
    renderConversationList();
    testEmptyState.classList.add("hidden");
    closeStoryReader();
    testConversationPanel.classList.remove("hidden");
    try {
        renderTestMessages(selectedConversation(), await storageApi.getPrompts(conversationId));
    } catch (err) {
        if (sessionExpired(err)) return;
        renderTestMessages(selectedConversation(), []);
    }
    refreshPublishStatus(conversationId);
}

function setBusy(busy) {
    testState.busy = busy;
    testSendBtn.disabled = busy;
    skipQuestionBtn.disabled = busy;
    endInterviewBtn.disabled = busy;
    deleteInterviewBtn.disabled = busy;
    // Hands-free: an answer finished while the interviewer was busy goes out
    // as soon as it's free, rather than waiting for the Send button.
    if (!busy && autoSendWaiting) {
        autoSendWaiting = false;
        if (handsFree && dictation?.listening && !sessionEnded) setTimeout(sendAnswer, 0);
    }
}

// Runs one call to the interviewer with a "..." bubble standing in for its
// reply. The reply only lands if the same conversation is still open.
async function withInterviewer(conversationId, call) {
    setBusy(true);
    const pending = appendMessage("assistant", "…");
    pending.classList.add("pending");
    try {
        return await call();
    } finally {
        pending.remove();
        setBusy(false);
    }
}

function stillSelected(conversationId) {
    return testState.selectedConversationId === conversationId;
}

// A new question from the interviewer: shown, and read aloud if voice is on.
function showQuestion(question) {
    appendQuestion(question);
    speaker?.speak(question);
}

newTestConversationBtn.addEventListener("click", async () => {
    let conversationId;
    try {
        ({ conversation_id: conversationId } = await storageApi.createConversation());
    } catch (err) {
        if (sessionExpired(err)) return;
        alert(errorText(err) || "Failed to create conversation");
        return;
    }
    await refreshTestConversations();
    await selectTestConversation(conversationId);
    // A new interview keeps the ✋ Hands-free setting as it was last left.
    setHandsFree(savedHandsFree());

    try {
        const { question } = await withInterviewer(conversationId, () =>
            storageApi.startInterview(conversationId, interviewModeSelect.value)
        );
        // The mode and opening question now live on the conversation.
        await refreshTestConversations();
        if (stillSelected(conversationId)) {
            showQuestion(question);
            // Where the browser can listen, the mic opens (it waits out the
            // question being read aloud, see speaker); the answer box takes
            // typing either way, and 🎤 turns the mic off.
            if (dictation) startMicrophone();
            else testMessageInput.focus();
        }
    } catch (err) {
        if (sessionExpired(err)) return;
        if (stillSelected(conversationId)) {
            appendMessage("error", `${errorText(err)} You can still start by telling your story below.`);
        }
    }
});

async function sendAnswer() {
    const conversationId = testState.selectedConversationId;
    if (!conversationId || testState.busy || sessionEnded) return;
    const content = testMessageInput.value.trim();
    if (!content) return;

    // The storyteller has answered -- no need to finish reading the question.
    speaker?.stop();
    // Hands-free keeps listening for the next answer; otherwise the mic goes
    // off, and anything not yet in the box is dropped so it can't reappear
    // there after the box has been cleared.
    if (!handsFree) dictation?.stop({ discard: true });
    testMessageInput.value = "";
    appendMessage("user", content);

    try {
        const { question } = await withInterviewer(conversationId, () =>
            storageApi.answerInterview(conversationId, content)
        );
        if (stillSelected(conversationId)) showQuestion(question);
    } catch (err) {
        if (sessionExpired(err)) return;
        if (!stillSelected(conversationId)) return;
        // A 4xx means the answer itself was refused; otherwise it was saved
        // and only the next question is missing.
        if (!err.status) {
            appendMessage("error", "Couldn't reach the server, so your answer may not have been saved.");
            testMessageInput.value = content;
        } else if (err.status < 500) {
            appendMessage("error", `Not sent: ${errorText(err)}`);
            testMessageInput.value = content;
        } else {
            appendMessage("error", `${errorText(err)} Your answer was saved -- press "Skip question" to get a question.`);
        }
    }
}

testMessageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendAnswer();
});

// Enter sends, Shift+Enter starts a new line.
testMessageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendAnswer();
    }
});

// Redraws from the server rather than patching the list, since the question
// being replaced may be the opening one or the one after the latest answer.
skipQuestionBtn.addEventListener("click", async () => {
    const conversationId = testState.selectedConversationId;
    if (!conversationId || testState.busy || sessionEnded) return;
    speaker?.stop();
    try {
        const { question } = await withInterviewer(conversationId, () =>
            storageApi.skipInterviewQuestion(conversationId)
        );
        await refreshTestConversations();
        if (stillSelected(conversationId)) {
            await selectTestConversation(conversationId, { keepVoice: true });
            speaker?.speak(question);
        }
    } catch (err) {
        if (sessionExpired(err)) return;
        if (stillSelected(conversationId)) appendMessage("error", errorText(err));
    }
});

// Back to "pick a topic or a story", with no interview open.
function closeTestConversation() {
    stopVoice({ discard: true });
    testState.selectedConversationId = null;
    testConversationPanel.classList.add("hidden");
    testEmptyState.classList.remove("hidden");
    renderConversationList();
}

// Deletes an interview for good (after asking): every question and answer,
// the drafts written from it and its transcript. A story published from it
// stays up -- the question says so -- and is deleted on its own. Not while
// the interviewer is working on this interview, so a reply can't land in one
// that's gone.
async function deleteInterview(conversationId) {
    if (sessionEnded) return;
    const conversation = testState.conversations.find((c) => c.conversation_id === conversationId);
    if (!conversation) return;
    if (testState.busy && stillSelected(conversationId)) {
        alert("Wait for the interviewer to finish, then delete the interview.");
        return;
    }

    const published = (storyState.myStories || []).some((story) => story.conversation_id === conversationId);
    const keeps = published
        ? "\n\nThe story you published from it stays up. Delete it from Your Stories if you want it gone too."
        : "";
    if (!confirm(`Delete "${conversationTitle(conversation)}"? All of its questions and answers will be gone for good.${keeps}`)) {
        return;
    }

    deleteInterviewBtn.disabled = true;
    try {
        await storageApi.deleteConversation(conversationId);
    } catch (err) {
        if (sessionExpired(err)) return;
        // Already gone (deleted in another tab): carry on and drop it here too.
        if (err.status !== 404) {
            alert(`Couldn't delete the interview: ${errorText(err)}`);
            return;
        }
    } finally {
        deleteInterviewBtn.disabled = false;
    }

    if (stillSelected(conversationId)) closeTestConversation();
    await refreshTestConversations();
    // Its story (if any) no longer points back to it, so the reader drops
    // "Edit story" and the drawers redraw without the interview's topic.
    if (typeof refreshStoryFeeds === "function") refreshStoryFeeds();
}

deleteInterviewBtn.addEventListener("click", () => {
    if (testState.selectedConversationId !== null) deleteInterview(testState.selectedConversationId);
});

async function answerWasSaved(conversationId, answer) {
    try {
        const prompts = await storageApi.getPrompts(conversationId);
        return prompts.at(-1)?.content === answer;
    } catch (err) {
        return false;
    }
}

// "End", as on the original interview page, and the one way to get a story
// out of an interview. After a confirm the microphone and voice go off and the
// whole interview -- every question and answer -- is written up as a story by
// the interviewer (one call to Claude, see ../interview.js), with a title,
// summary, place, time period and tags; it then opens in the publish dialog.
//
// Words still being dictated are waited for, and whatever is in the answer
// box goes along with the request, so ending mid-sentence keeps that sentence
// -- without asking the interviewer for a next question nobody will see. A
// "Writing your story…" bubble stands in while Claude works.
//
// With nothing answered at all there is no story to write, so the interview
// is just closed (it stays under "Your Interviews" to pick back up).
endInterviewBtn.addEventListener("click", async () => {
    const conversationId = testState.selectedConversationId;
    if (!conversationId || testState.busy || sessionEnded) return;
    if (!confirm("End this interview and write it up as your story?")) return;

    const label = endInterviewBtn.textContent;
    endInterviewBtn.textContent = "Writing…";
    // Busy also keeps hands-free from sending the last words as an answer
    // while they are collected; the ✋ setting itself is left as chosen.
    setBusy(true);
    autoSendWaiting = false;
    speaker?.stop();
    // Let Chrome hand over the last words it heard into the answer box.
    await dictation?.finish();
    if (sessionEnded || !stillSelected(conversationId)) {
        endInterviewBtn.textContent = label;
        if (!sessionEnded) setBusy(false);
        return;
    }
    stopVoice();

    const answer = testMessageInput.value.trim();
    const answerBubble = answer ? appendMessage("user", answer) : null;
    if (answer) testMessageInput.value = "";
    const pending = appendMessage("assistant", "✍️ Writing your story…");
    pending.classList.add("pending", "writing");
    try {
        const drafted = await storageApi.draftInterviewStory(conversationId, { answer });
        // The server's interview AI is switched off: nothing wrote the story,
        // it's the answers as they were. Said in the chat and on top of the
        // publish form (which covers the chat), rather than passed off.
        const notice =
            drafted.ai === false
                ? "The AI story writer is switched off on this server, so this is just your answers as you gave " +
                  "them. (Server setup: set INTERVIEW_AI=bedrock and AWS credentials -- in src/.env locally, or in " +
                  "the host's environment settings, e.g. Render.)"
                : "";
        if (notice && stillSelected(conversationId)) appendMessage("error", notice);
        if (stillSelected(conversationId)) {
            await openPublishModal(conversationId, { draft: drafted.story, details: drafted, notice });
        }
    } catch (err) {
        if (sessionExpired(err) || !stillSelected(conversationId)) return;
        // Nothing answered yet: no story to write, so just close it.
        if (err.status === 400 && !answer) {
            closeTestConversation();
            return;
        }
        // The server saves the last answer before writing the story, so it is
        // usually kept even when the story failed; if it never got there, it
        // goes back in the box rather than being lost.
        if (answer && !(await answerWasSaved(conversationId, answer))) {
            testMessageInput.value = answer;
            answerBubble.remove();
        }
        const setupError = /isn't set up correctly/.test(errorText(err));
        appendMessage(
            "error",
            err.status === 400
                ? errorText(err)
                : setupError
                  ? `${errorText(err)} Your answers are all saved -- press End again once it's fixed.`
                  : `${errorText(err)} Your answers are all saved -- press End to try again.`
        );
    } finally {
        pending.remove();
        endInterviewBtn.textContent = label;
        if (!sessionEnded) setBusy(false);
    }
});

// ---- Answering out loud, and hearing the questions ----

// The ✋ Hands-free setting is the storyteller's choice: remembered on this
// device (like the voice toggle) and carried into every interview -- a new
// one, the next answer, and after End -- until the ✋ button turns it off.
const HANDS_FREE_KEY = "reellife_hands_free";
let handsFree = false;
// A hands-free answer that finished while the interviewer was busy.
let autoSendWaiting = false;

function savedHandsFree() {
    try {
        return localStorage.getItem(HANDS_FREE_KEY) === "on";
    } catch (err) {
        return false;
    }
}

function setHandsFree(on, { remember = false } = {}) {
    handsFree = Boolean(on && dictation);
    if (remember) {
        try {
            localStorage.setItem(HANDS_FREE_KEY, handsFree ? "on" : "off");
        } catch (err) {
            // Storage blocked (private mode): it holds for this page only.
        }
    }
    handsFreeBtn.textContent = handsFree ? "✋ Hands-free on" : "✋ Hands-free off";
    handsFreeBtn.classList.toggle("off", !handsFree);
    handsFreeBtn.setAttribute("aria-pressed", String(handsFree));
    renderMicHint();
}

// The Story Companion card used to have an "Answer mode" picker (Speak /
// Type); speaking and typing are now both always there (🎤 and the answer
// box). Its old saved choice is cleared, and the even older "Speak
// hands-free" choice still carries over as ✋ Hands-free on.
const OLD_ANSWER_MODE_KEY = "reellife_answer_mode";
try {
    if (localStorage.getItem(OLD_ANSWER_MODE_KEY) === "handsFree" && localStorage.getItem(HANDS_FREE_KEY) === null) {
        localStorage.setItem(HANDS_FREE_KEY, "on");
    }
    localStorage.removeItem(OLD_ANSWER_MODE_KEY);
} catch (err) {
    // Storage blocked (private mode): nothing was saved to clear.
}

const MIC_PROBLEM_HINTS = {
    offline: "You're offline -- listening picks up again when you're back online.",
    "no-microphone": "No working microphone found. Check it's plugged in and not in use by another app.",
    blocked: "The microphone is blocked. Allow it in the browser's site settings, then tap 🎤 again.",
};
const MIC_STATUS_HINTS = {
    connecting: "Connecting to the microphone…",
    reconnecting: "Reconnecting to the microphone…",
};

// One line under the answer box saying what the microphone is doing.
function renderMicHint() {
    let text = "";
    let problem = false;
    if (dictation) {
        if (speaker?.speaking && dictation.listening) {
            text = "🔊 The interviewer is speaking -- the microphone listens again when the question ends.";
        } else if (MIC_PROBLEM_HINTS[dictation.state]) {
            text = MIC_PROBLEM_HINTS[dictation.state];
            problem = true;
        } else if (dictation.listening && MIC_STATUS_HINTS[dictation.state]) {
            text = MIC_STATUS_HINTS[dictation.state];
        } else if (dictation.listening && handsFree) {
            text = "Listening -- pause for a moment and your answer is sent.";
        }
    }
    micHint.textContent = text;
    micHint.classList.toggle("hidden", !text);
    micHint.classList.toggle("problem", problem);
}

// Finished phrases go into the answer box (so they can be fixed before
// sending); the phrase still being heard shows as a caption underneath.
const dictation = createDictation({
    onFinalText(text) {
        if (!text) return;
        const current = testMessageInput.value.trimEnd();
        testMessageInput.value = current ? `${current} ${text}` : text;
        testMessageInput.scrollTop = testMessageInput.scrollHeight;
    },
    onInterimText(text) {
        liveCaption.textContent = text;
        liveCaption.classList.toggle("hidden", !text);
    },
    onListeningChange(listening) {
        micBtn.classList.toggle("listening", listening);
        micBtn.title = listening ? "Stop listening" : "Answer out loud";
        micBtn.setAttribute("aria-pressed", String(listening));
        testMessageInput.placeholder = listening ? "Listening… your words will appear here" : "Tell your story...";
        renderMicHint();
    },
    onStateChange: renderMicHint,
    onError(message) {
        appendMessage("error", message);
    },
    // Hands-free: the storyteller stopped talking, so the answer is complete.
    // Sent right away, or as soon as the interviewer is free again.
    onSpeechPause() {
        if (!handsFree || !dictation.listening) return;
        if (testState.busy) autoSendWaiting = true;
        else sendAnswer();
    },
});

// Reads each question aloud; the mic is suspended meanwhile so the
// interviewer's own voice isn't taken for the answer.
const speaker = createSpeaker({
    onSpeakingChange(speaking) {
        if (speaking) dictation?.suspend();
        else dictation?.resume();
        renderMicHint();
    },
});

function stopVoice({ discard = false } = {}) {
    autoSendWaiting = false;
    dictation?.stop({ discard });
    speaker?.stop();
}

// Opens the microphone -- but only after checking with the server that the
// sign-in is still good, so a stale page never starts listening.
async function startMicrophone() {
    if (!dictation || dictation.listening) return;
    if (!(await sessionWatch.verify())) return;
    const on = await dictation.start();
    if (on && speaker?.speaking) dictation.suspend();
}

if (dictation) {
    micBtn.addEventListener("click", () => {
        if (dictation.listening) dictation.stop();
        else startMicrophone();
    });

    handsFreeBtn.addEventListener("click", () => {
        setHandsFree(!handsFree, { remember: true });
        if (handsFree) startMicrophone();
    });
} else {
    // No speech recognition in this browser: answers are typed.
    micBtn.classList.add("hidden");
    handsFreeBtn.classList.add("hidden");
}

// Show the ✋ button as it was last left.
setHandsFree(savedHandsFree());

if (speaker) {
    voiceToggleBtn.addEventListener("click", () => {
        const on = speaker.setEnabled(!speaker.enabled);
        voiceToggleBtn.textContent = on ? "🔊 Voice on" : "🔈 Voice off";
        voiceToggleBtn.classList.toggle("off", !on);
        voiceToggleBtn.setAttribute("aria-pressed", String(on));
        voiceToggleBtn.title = on ? "Questions are read aloud -- click to mute" : "Click to hear questions read aloud";
    });
    if (!speaker.enabled) {
        voiceToggleBtn.textContent = "🔈 Voice off";
        voiceToggleBtn.classList.add("off");
        voiceToggleBtn.setAttribute("aria-pressed", "false");
    }
} else {
    voiceToggleBtn.classList.add("hidden");
}

// ---- Keeping the sign-in honest ----

let sessionEnded = false;

// The session is gone (expired, signed out elsewhere, or another account took
// over). Everything that listens or talks is shut off and the words not yet
// sent are dropped, then the user is sent to sign in again.
function handleSessionLost(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    handsFree = false;
    stopVoice({ discard: true });
    sessionWatch.stop();

    testMessageInput.value = "";
    testMessageInput.disabled = true;
    micBtn.disabled = true;
    handsFreeBtn.disabled = true;
    voiceToggleBtn.disabled = true;
    liveCaption.classList.add("hidden");
    renderMicHint();
    setBusy(true);

    if (reason === "changed") {
        appendMessage("error", "A different account signed in on another tab, so this interview was closed. Reloading…");
        // Not goToLogin(): that would sign the *other* account out.
        setTimeout(() => window.location.reload(), 2000);
    } else {
        appendMessage("error", "Your session has ended, so the microphone and voice are off. Taking you to sign in…");
        setTimeout(() => goToLogin(), 2000);
    }
}

// Any interview call can find the session gone (apiFetch has already cleared
// the dead token); true means it was, and has been dealt with.
function sessionExpired(err) {
    if (err && err.status === 401) {
        handleSessionLost("expired");
        return true;
    }
    return false;
}

const sessionWatch = createSessionWatch({
    check: () => storageApi.whoami(),
    isSignedIn: () => storageApi.isLoggedIn(),
    tokenKey: AUTH_TOKEN_KEY,
    onLost: handleSessionLost,
});
sessionWatch.start();

// Logging out, leaving the page, leaving the Story tab or opening the publish
// dialog all end listening and speaking right away.
document.querySelector("#headerLogoutButton").addEventListener("click", () => {
    handsFree = false;
    stopVoice({ discard: true });
});
window.addEventListener("pagehide", () => stopVoice({ discard: true }));

function whenHiddenOrInactive(element, isShowing) {
    new MutationObserver(() => {
        if (!isShowing(element)) stopVoice();
    }).observe(element, { attributes: true, attributeFilter: ["class"] });
}
whenHiddenOrInactive(document.querySelector("#tellYourStorySection"), (el) => el.classList.contains("active"));
whenHiddenOrInactive(document.querySelector("#publishModal"), (el) => el.classList.contains("hidden"));

refreshTestConversations();
