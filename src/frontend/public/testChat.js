// "Tell Your Story" tab: a conversation list (like ai-chat-ui's sidebar)
// backed by the same storage_api.js used elsewhere, but the chat itself only
// accepts user input -- each message gets a canned assistant reply generated
// locally (no real AI is wired up), and both sides of the exchange are
// persisted as one prompt via storageApi.addPrompt / storageApi.addResponse.
//
// Publishing a conversation as a story lives in stories.js, which owns the
// publish bar above the message list; this file just tells it which
// conversation is selected (refreshPublishStatus).

const testState = {
    conversations: [],
    selectedConversationId: null,
};

const newTestConversationBtn = document.querySelector("#newTestConversationBtn");
const testConversationList = document.querySelector("#testConversationList");
const testEmptyState = document.querySelector("#testEmptyState");
const testConversationPanel = document.querySelector("#testConversationPanel");
const testMessageList = document.querySelector("#testMessageList");
const testMessageForm = document.querySelector("#testMessageForm");
const testMessageInput = document.querySelector("#testMessageInput");

const CANNED_RESPONSES = [
    "That's a great memory -- what happened next?",
    "I'd love to hear more about that. Who else was there?",
    "Thanks for sharing! How did that make you feel at the time?",
    "Interesting -- can you describe the place a bit more?",
    "What do you remember most vividly about that moment?",
];

function generateAssistantReply() {
    return CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)];
}

function appendMessage(role, text) {
    const item = document.createElement("div");
    item.className = `message message-${role}`;
    item.textContent = text;
    testMessageList.appendChild(item);
    testMessageList.scrollTop = testMessageList.scrollHeight;
}

function renderTestMessages(prompts) {
    testMessageList.innerHTML = "";
    const interview = isInterview(
        testState.conversations.find((c) => c.conversation_id === testState.selectedConversationId)
    );
    for (const prompt of prompts) {
        // An interview row is an answer plus the question that prompted it, so
        // the question goes first; a typed chat row is a message plus its reply.
        if (interview && prompt.response) appendMessage("assistant", prompt.response);
        appendMessage("user", prompt.content);
        if (!interview && prompt.response) appendMessage("assistant", prompt.response);
    }
}

// Recorded interviews are numbered per user ("Interview #3", see
// ../conversations.js); anything else is a typed conversation.
function isInterview(conversation) {
    return conversation?.kind === "interview";
}

function conversationLabel(conversation) {
    const when = new Date(conversation.creation_date).toLocaleString();
    if (isInterview(conversation)) {
        const mode = conversation.interview_mode ? ` · ${conversation.interview_mode}` : "";
        return `Interview #${conversation.interview_number}${mode} · ${when}`;
    }
    return `Conversation #${conversation.conversation_id} · ${when}`;
}

function renderConversationList() {
    testConversationList.innerHTML = "";
    for (const conversation of testState.conversations) {
        const item = document.createElement("li");
        item.className = "testConversationItem";
        item.classList.toggle("selected", conversation.conversation_id === testState.selectedConversationId);
        item.textContent = conversationLabel(conversation);
        item.addEventListener("click", () => selectTestConversation(conversation.conversation_id));
        testConversationList.appendChild(item);
    }
}

async function refreshTestConversations() {
    try {
        testState.conversations = await storageApi.listConversations();
    } catch (err) {
        testState.conversations = [];
    }
    renderConversationList();
}

async function selectTestConversation(conversationId) {
    testState.selectedConversationId = conversationId;
    renderConversationList();
    testEmptyState.classList.add("hidden");
    testConversationPanel.classList.remove("hidden");

    // An interview continues through the interviewer, not the canned typed
    // chat, so it gets "Resume interview" in place of the message box.
    const conversation = testState.conversations.find((c) => c.conversation_id === conversationId);
    const interview = isInterview(conversation);
    resumeInterviewBtn.classList.toggle("hidden", !interview);
    testMessageForm.classList.toggle("hidden", interview);

    try {
        renderTestMessages(await storageApi.getPrompts(conversationId));
    } catch (err) {
        renderTestMessages([]);
    }
    refreshPublishStatus(conversationId);
}

newTestConversationBtn.addEventListener("click", async () => {
    try {
        const conversation = await storageApi.createConversation();
        await refreshTestConversations();
        await selectTestConversation(conversation.conversation_id);
    } catch (err) {
        alert(err.detail || "Failed to create conversation");
    }
});

testMessageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!testState.selectedConversationId) return;
    const content = testMessageInput.value.trim();
    if (!content) return;
    testMessageInput.value = "";

    try {
        const { prompt_id } = await storageApi.addPrompt(testState.selectedConversationId, { content });
        appendMessage("user", content);

        const reply = generateAssistantReply();
        await storageApi.addResponse(prompt_id, { response: reply });
        appendMessage("assistant", reply);
    } catch (err) {
        appendMessage("assistant", `(failed to send: ${err.detail || err.message})`);
    }
});

// ---- Interview hand-off ----
// The launcher above the conversation list starts a real Claude interview
// (interview.html) rather than the canned chat in this file. The method travels
// in sessionStorage because that's where interview.html reads it from; the mode
// travels in the URL, where the server matches it to one of its per-mode system
// prompts (see systemPrompts in src/server/server.js).

const startInterviewBtn = document.querySelector("#startInterviewBtn");
const interviewModeSelect = document.querySelector("#interviewModeSelect");
const interviewMethodSelect = document.querySelector("#interviewMethodSelect");

const interviewPanel = document.querySelector("#interviewPanel");
const interviewFrame = document.querySelector("#interviewFrame");
const resumeInterviewBtn = document.querySelector("#resumeInterviewBtn");

function showInterviewPane(src) {
    interviewFrame.src = src;
    testEmptyState.classList.add("hidden");
    testConversationPanel.classList.add("hidden");
    interviewPanel.classList.remove("hidden");
}

// The interview shows up in the pane the same way the conversation view does,
// instead of navigating away from the app. Framing the page is what makes that
// possible without a second copy of its markup, styles and script; it also keeps
// the two stylesheets' .message rules from reaching into each other.
//
// Nothing sits above the frame: the interview page brings its own header
// (status, timer, back and End), and the pane's full height is what lets it line
// up with the navigation column beside it.
function openInterviewPanel() {
    if (!interviewPanel.classList.contains("hidden")
        && !confirm("Start a new interview? The one on screen will be closed.")) {
        return;
    }

    // interview.html reads the method from sessionStorage and the mode from the
    // URL, where the server matches it to one of its per-mode system prompts
    // (see systemPrompts in src/server/server.js).
    sessionStorage.setItem("interviewMethod", interviewMethodSelect.value);
    // A new interview is a new recording: forget the previous interview's
    // conversation so nothing (e.g. its chapter preview) points back at it.
    sessionStorage.removeItem("interviewConversationId");
    showInterviewPane(`interview.html?mode=${encodeURIComponent(interviewModeSelect.value)}`);
}

// Picks the selected recorded interview back up in the pane, with the mode and
// answer method it was started with, so it's the same interviewer continuing
// the same conversation (interview.html?resume=... -- see interviewStorage.js).
function resumeSelectedInterview() {
    const conversation = testState.conversations.find(
        (c) => c.conversation_id === testState.selectedConversationId
    );
    if (!isInterview(conversation)) return;

    sessionStorage.setItem("interviewMethod", conversation.interview_method || "audio");
    sessionStorage.setItem("interviewConversationId", String(conversation.conversation_id));
    const mode = conversation.interview_mode || "Life Period";
    showInterviewPane(
        `interview.html?mode=${encodeURIComponent(mode)}&resume=${conversation.conversation_id}`
    );
}

resumeInterviewBtn.addEventListener("click", resumeSelectedInterview);

// Clearing the src unloads the interview page, which is also what stops its
// timer and microphone (its own beforeunload handler -- see interview.html).
function closeInterviewPanel() {
    interviewPanel.classList.add("hidden");
    interviewFrame.src = "about:blank";

    if (testState.selectedConversationId === null) {
        testEmptyState.classList.remove("hidden");
    } else {
        // Reloaded rather than just un-hidden: the selection may be the
        // interview that just ran, whose turns arrived while the pane was open.
        selectTestConversation(testState.selectedConversationId);
    }
}

// No close button out here: the interview page's own back button closes the
// pane (reellife:close-interview below).
startInterviewBtn.addEventListener("click", openInterviewPanel);

// The interview page and its chapter preview live in the frame, so they report
// back through postMessage rather than being rewritten here: closing the pane
// when their back button is used, and showing the conversation once the chapter
// preview is done with (see the embedded handling in both pages).
window.addEventListener("message", async (event) => {
    if (event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "reellife:close-interview") {
        closeInterviewPanel();
    } else if (message.type === "reellife:interview-logged") {
        // A new interview session was just logged (see beginSession() in
        // interviewStorage.js): list it now and mark it as the one running,
        // without swapping the interview pane out. Closing the pane later
        // then lands on this interview's conversation.
        await refreshTestConversations();
        if (testState.conversations.some((c) => c.conversation_id === message.conversationId)) {
            testState.selectedConversationId = message.conversationId;
            renderConversationList();
        }
    } else if (message.type === "reellife:interview-finished") {
        // The pane has no status bar of its own any more, so the visible sign
        // is the sidebar: the interview's conversation (created on its first
        // saved answer) shows up in the list while the preview is on screen.
        await refreshTestConversations();
    } else if (message.type === "reellife:show-conversation") {
        closeInterviewPanel();
        await selectConversation(message.conversationId);
    } else if (message.type === "reellife:need-login") {
        // The frame can't navigate the whole window out of a dead session.
        window.location.href = "login.html";
    }
});

async function selectConversation(conversationId) {
    if (!Number.isInteger(conversationId) || conversationId <= 0) return;

    // The interview's conversation may have been created since the list was
    // last fetched.
    await refreshTestConversations();
    if (testState.conversations.some((conversation) => conversation.conversation_id === conversationId)) {
        await selectTestConversation(conversationId);
    }
}

// Arriving from an interview -- chapter-preview.html links back here with
// ?conversation=... -- should land on that conversation instead of making the
// author find it in the list. saveLastPage() also has to record the Story tab,
// otherwise script.js's restoreLastPage(), which runs once /whoami confirms the
// session, drops them on whichever tab they last visited.
async function selectConversationFromUrl() {
    const requested = Number(new URLSearchParams(window.location.search).get("conversation"));
    if (!Number.isInteger(requested) || requested <= 0) return;

    saveLastPage("story");
    await selectConversation(requested);
}

(async function initTestChat() {
    await refreshTestConversations();
    await selectConversationFromUrl();
})();
