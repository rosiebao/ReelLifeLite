// History tab: every story "Write my story" has written (saved server-side by
// ../interview.js, listed by ../drafts.js). A draft can be opened back up in
// the publish dialog -- on the Story tab, with its interview selected -- or
// deleted. Like stories.js, the text goes in through textContent only.

const historyList = document.querySelector("#historyList");
const historyEmpty = document.querySelector("#historyEmpty");

// Long drafts start folded to a few lines; shorter ones get no toggle.
const HISTORY_FOLD_LENGTH = 400;

function draftHeading(draft) {
    const kind = draft.interview_mode ? `${draft.interview_mode} interview` : "Interview";
    return `${kind} #${draft.conversation_id} · ${new Date(draft.created_at).toLocaleString()}`;
}

function historyButton(label, onClick, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", onClick);
    return button;
}

function historyItem(draft) {
    const item = document.createElement("li");
    item.className = "historyItem";

    const heading = document.createElement("h3");
    heading.textContent = draftHeading(draft);
    item.appendChild(heading);

    const text = document.createElement("p");
    text.className = "historyText";
    text.textContent = draft.content;
    item.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "historyActions";

    if (draft.content.length > HISTORY_FOLD_LENGTH) {
        text.classList.add("folded");
        const toggle = historyButton("Show more", () => {
            const folded = text.classList.toggle("folded");
            toggle.textContent = folded ? "Show more" : "Show less";
        });
        actions.appendChild(toggle);
    }

    const spacer = document.createElement("span");
    spacer.className = "modalSpacer";
    actions.appendChild(spacer);

    actions.appendChild(historyButton("Delete", () => deleteDraft(draft), "dangerButton"));
    actions.appendChild(historyButton("Open in publish form", () => openDraft(draft), "primaryButton"));
    item.appendChild(actions);
    return item;
}

async function refreshHistory() {
    let drafts = [];
    try {
        drafts = await storageApi.listDrafts();
    } catch (err) {
        drafts = [];
    }
    historyList.innerHTML = "";
    for (const draft of drafts) historyList.appendChild(historyItem(draft));
    show(historyEmpty, drafts.length === 0);
}

// Same place "Write my story" would have left it: the Story tab with that
// interview open, and the draft in the publish dialog.
async function openDraft(draft) {
    showPage("story");
    await selectTestConversation(draft.conversation_id);
    await openPublishModal(draft.conversation_id, { draft: draft.content });
}

async function deleteDraft(draft) {
    if (!confirm("Delete this story from your history? This can't be undone.")) return;
    try {
        await storageApi.deleteDraft(draft.draft_id);
    } catch (err) {
        alert(errorMessage(err));
        return;
    }
    refreshHistory();
}

$("#history").click(refreshHistory);
refreshHistory();
