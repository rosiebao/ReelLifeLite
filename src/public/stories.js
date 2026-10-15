// Publishing a conversation as a story, and the Friends/Community feeds that
// read those stories back.
//
// Everything user-written (titles, summaries, story text, usernames) goes into
// the page through textContent or a created text node -- never innerHTML with
// a template string. These feeds show text written by *other* accounts, so a
// story titled `<img onerror=...>` would otherwise run in a reader's session.

const VISIBILITY_LABELS = {
    private: "Only me",
    friends: "Friends",
    public: "Everyone",
};

const storyState = {
    // The conversation the publish dialog is currently open for, and the story
    // it already has (null when publishing for the first time).
    publishingConversationId: null,
    publishingStory: null,
    // The form's values as the dialog opened with them, so closing can tell
    // whether anything has been typed since (publishFormDirty).
    publishingSnapshot: null,
    // True when the story text was just written on "End". There's no tab to
    // find it again, so closing without publishing asks first.
    publishingDraft: false,
    // The story open in the reader, so "Add friend" knows whose it is.
    readingStory: null,
    // The signed-in user's own stories (newest first), for the Story tab's
    // "Your Stories" drawer -- and so "Your Interviews" can title each
    // interview after the story published from it.
    myStories: [],
    // The story open in the Story tab's reader (#storyReader).
    tabReaderStory: null,
};

const publishModal = document.querySelector("#publishModal");
const publishForm = document.querySelector("#publishForm");
const publishModalTitle = document.querySelector("#publishModalTitle");
const publishTitleInput = document.querySelector("#publishTitle");
const publishSummaryInput = document.querySelector("#publishSummary");
const publishPlaceInput = document.querySelector("#publishPlace");
const publishTimePeriodInput = document.querySelector("#publishTimePeriod");
const publishTagsInput = document.querySelector("#publishTags");
const publishVisibilitySelect = document.querySelector("#publishVisibility");
const publishContentInput = document.querySelector("#publishContent");
const publishError = document.querySelector("#publishError");
const publishNotice = document.querySelector("#publishNotice");
const publishSubmitBtn = document.querySelector("#publishSubmitBtn");
const publishCancelBtn = document.querySelector("#publishCancelBtn");
const unpublishBtn = document.querySelector("#unpublishBtn");

const storyModal = document.querySelector("#storyModal");
const storyModalTitle = document.querySelector("#storyModalTitle");
const storyModalByline = document.querySelector("#storyModalByline");
const storyModalSetting = document.querySelector("#storyModalSetting");
const storyModalTags = document.querySelector("#storyModalTags");
const storyModalContent = document.querySelector("#storyModalContent");
const storyModalCloseBtn = document.querySelector("#storyModalCloseBtn");
const storyAddFriendBtn = document.querySelector("#storyAddFriendBtn");

const myStoriesGrid = document.querySelector("#myStories");
const myStoriesEmpty = document.querySelector("#myStoriesEmpty");
const friendStoriesGrid = document.querySelector("#friendStories");
const friendStoriesEmpty = document.querySelector("#friendStoriesEmpty");
const featuredStory = document.querySelector("#featuredStory");
const communityFeaturedEmpty = document.querySelector("#communityFeaturedEmpty");
const communityStoriesGrid = document.querySelector("#communityStories");
const communityStoriesEmpty = document.querySelector("#communityStoriesEmpty");

function show(element, visible) {
    element.classList.toggle("hidden", !visible);
}

function errorMessage(err) {
    return err?.detail || err?.message || "Something went wrong";
}

// ---- Card building ----

function tagElements(tags) {
    return tags.map((tag) => {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = `#${tag}`;
        return span;
    });
}

// "Chicago · 1950s-Present", with the separator dropped when only one half is
// filled in, and the whole line skipped when neither is.
function settingLine(story) {
    const parts = [];
    if (story.place) parts.push(["place", story.place]);
    if (story.time_period) parts.push(["time", story.time_period]);
    if (!parts.length) return null;

    const line = document.createElement("p");
    line.className = "setting";
    parts.forEach(([className, value], index) => {
        if (index > 0) line.append(" • ");
        const span = document.createElement("span");
        span.className = className;
        span.textContent = value;
        line.appendChild(span);
    });
    return line;
}

// Who can read one of your own stories, in place of the "By you" byline.
function visibilityLine(story) {
    const line = document.createElement("p");
    const badge = document.createElement("span");
    badge.className = "visibilityBadge";
    badge.textContent = VISIBILITY_LABELS[story.visibility] || story.visibility;
    line.appendChild(badge);
    return line;
}

// ---- Feeds ----

// Everything the user has published, whatever its visibility. This is the
// only place an "Only me" story shows up -- the Friends feed leaves out your
// own stories and the Community feed only has public ones.
async function refreshMyStories() {
    let stories = [];
    try {
        stories = await storageApi.listMyStories();
    } catch (err) {
        stories = [];
    }
    storyState.myStories = stories;
    myStoriesGrid.innerHTML = "";
    for (const story of stories) myStoriesGrid.appendChild(friendStoryCard(story, { own: true }));
    show(myStoriesEmpty, stories.length === 0);
    // A story open in the Story tab's reader may have just been edited or
    // unpublished: show the new version, or go back to the empty state.
    const reading = storyState.tabReaderStory;
    if (reading) {
        if (stories.some((story) => story.story_id === reading.story_id)) {
            openTabStoryReader(reading.story_id);
        } else {
            closeStoryReader();
            if (testState.selectedConversationId === null) show(testEmptyState, true);
        }
    }
    renderMyStoryDrawer();
    // Interviews are titled after their stories (testChat.js).
    renderConversationList();
}

// ---- The Story tab's "Your Stories" drawer and reader ----

const myStoryList = document.querySelector("#myStoryList");
const myStoryCount = document.querySelector("#myStoryCount");
const myStoryLatest = document.querySelector("#myStoryLatest");
const storyReader = document.querySelector("#storyReader");
const storyReaderTopic = document.querySelector("#storyReaderTopic");
const storyReaderTitle = document.querySelector("#storyReaderTitle");
const storyReaderMeta = document.querySelector("#storyReaderMeta");
const storyReaderContent = document.querySelector("#storyReaderContent");
const storyReaderEditBtn = document.querySelector("#storyReaderEditBtn");

// The interview a story came from, if it's still in the list.
function storyConversation(story) {
    return testState.conversations.find((c) => c.conversation_id === story.conversation_id) || null;
}

// "Life Period" etc. -- the topic of the interview it came from, else its
// first tag, else nothing.
function storyTopic(story) {
    const conversation = storyConversation(story);
    if (conversation?.interview_mode) return topicLabel(conversation.interview_mode);
    return story.tags[0] || "";
}

function storyMeta(story) {
    const topic = storyTopic(story);
    return topic ? `${topic} · ${longDate(story.created_at)}` : longDate(story.created_at);
}

function renderMyStoryDrawer() {
    const stories = storyState.myStories;
    myStoryList.innerHTML = "";
    for (const story of stories) {
        myStoryList.appendChild(
            drawerItem({
                title: story.title,
                meta: storyMeta(story),
                selected: storyState.tabReaderStory?.story_id === story.story_id,
                onOpen: () => openTabStoryReader(story.story_id),
            })
        );
    }
    myStoryCount.textContent = stories.length;
    myStoryLatest.textContent = stories.length ? stories[0].title : "Nothing published yet";
}

// About 200 words a minute, and never "0 min".
function readingMinutes(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
}

// Paragraphs as <p>s, through textContent (see the note at the top).
function renderParagraphs(container, text) {
    container.innerHTML = "";
    for (const paragraph of text.split(/\n{2,}/)) {
        if (!paragraph.trim()) continue;
        const block = document.createElement("p");
        block.textContent = paragraph.trim();
        container.appendChild(block);
    }
}

// Opens one of your stories in the Story tab, in place of the interview.
async function openTabStoryReader(storyId) {
    let story;
    try {
        story = await storageApi.getStory(storyId);
    } catch (err) {
        alert(errorMessage(err));
        return;
    }

    // Leaving the interview: stop listening and talking, as switching
    // interviews does (testChat.js).
    stopVoice({ discard: true });
    testState.selectedConversationId = null;
    renderConversationList();

    storyState.tabReaderStory = story;
    const topic = storyTopic(story);
    storyReaderTopic.textContent = topic;
    show(storyReaderTopic, Boolean(topic));
    storyReaderTitle.textContent = story.title;
    storyReaderMeta.textContent = `${longDate(story.created_at)} • ${readingMinutes(story.content)} min read`;
    renderParagraphs(storyReaderContent, story.content);
    // Editing goes through the publish dialog, which needs the interview.
    show(storyReaderEditBtn, story.conversation_id !== null);

    show(testEmptyState, false);
    show(testConversationPanel, false);
    show(storyReader, true);
    storyReader.scrollTop = 0;
    renderMyStoryDrawer();
    // On a phone the drawer sits above the reader; fold it away to make room.
    storyReader.closest(".testLayout").querySelectorAll(".storyDrawer").forEach((drawer) => {
        drawer.open = false;
    });
}

// Called by testChat.js when an interview opens in its place.
function closeStoryReader() {
    if (!storyState.tabReaderStory) return;
    storyState.tabReaderStory = null;
    show(storyReader, false);
    renderMyStoryDrawer();
}

storyReaderEditBtn.addEventListener("click", () => {
    const story = storyState.tabReaderStory;
    if (story?.conversation_id === null || story?.conversation_id === undefined) return;
    openPublishModal(story.conversation_id);
});

// The Friends feed as the server last sent it (newest first), and which of the
// "All stories / Recent / Saved" chips is picked, so switching chips -- or
// un-saving a story while on "Saved" -- redraws without another request.
const friendFeedState = { stories: [], filter: "all" };

// "Recent" means published in the last month.
const RECENT_STORY_DAYS = 30;

const FRIEND_FEED_EMPTY = {
    all: "Nothing here yet. Add some friends, and their stories shared with friends will show up here.",
    recent: `None of your friends have shared a story in the last ${RECENT_STORY_DAYS} days.`,
    saved: "No saved stories yet. Tap the bookmark on a story to keep it here.",
};

async function refreshFriendStories() {
    let stories = [];
    try {
        stories = await storageApi.listFriendStories();
    } catch (err) {
        stories = [];
    }
    friendFeedState.stories = stories;
    renderFriendStories();
}

function filteredFriendStories() {
    const { stories, filter } = friendFeedState;
    if (filter === "recent") {
        const cutoff = Date.now() - RECENT_STORY_DAYS * 24 * 60 * 60 * 1000;
        return stories.filter((story) => new Date(story.created_at).getTime() >= cutoff);
    }
    if (filter === "saved") {
        const saved = savedStoryIds();
        return stories.filter((story) => saved.includes(story.story_id));
    }
    return stories;
}

function renderFriendStories() {
    const stories = filteredFriendStories();
    friendStoriesGrid.innerHTML = "";
    for (const story of stories) friendStoriesGrid.appendChild(friendStoryCard(story));
    friendStoriesEmpty.textContent = FRIEND_FEED_EMPTY[friendFeedState.filter];
    show(friendStoriesEmpty, stories.length === 0);
}

document.querySelectorAll("#friendStoryFilters .feedFilter").forEach((chip) => {
    chip.addEventListener("click", () => {
        friendFeedState.filter = chip.dataset.filter;
        document.querySelectorAll("#friendStoryFilters .feedFilter").forEach((other) => {
            const active = other === chip;
            other.classList.toggle("active", active);
            other.setAttribute("aria-pressed", String(active));
        });
        renderFriendStories();
    });
});

// "Apr 14, 2024".
function storyDate(story) {
    const date = new Date(story.created_at);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// One Friends card: a tall picture with the bookmark on its corner, then the
// title, the author with the date under their name, and the summary. `own`
// (the profile page's "My stories") swaps the bookmark and the author for the
// date and who the story is shared with.
function friendStoryCard(story, { own = false } = {}) {
    const card = document.createElement("article");
    card.className = "friendStoryCard";
    card.tabIndex = 0;
    card.setAttribute("aria-label", story.title);

    const cover = document.createElement("div");
    cover.className = "friendStoryCover";
    cover.appendChild(communityCover(story));
    // On "Saved", un-saving a story takes it off the page straight away.
    if (!own) {
        cover.appendChild(
            bookmarkButton(story, () => {
                if (friendFeedState.filter === "saved") renderFriendStories();
            })
        );
    }
    card.appendChild(cover);

    const body = document.createElement("div");
    body.className = "friendStoryBody";

    const title = document.createElement("h4");
    title.textContent = story.title;
    body.appendChild(title);

    if (own) {
        const meta = visibilityLine(story);
        meta.className = "ownStoryMeta";
        const date = document.createElement("span");
        date.className = "storyDate";
        date.textContent = storyDate(story);
        meta.appendChild(date);
        body.appendChild(meta);
    } else {
        const author = communityAuthor(story);
        const nameBlock = document.createElement("span");
        nameBlock.className = "authorText";
        nameBlock.appendChild(author.querySelector(".author"));
        const date = document.createElement("span");
        date.className = "storyDate";
        date.textContent = storyDate(story);
        nameBlock.appendChild(date);
        author.appendChild(nameBlock);
        body.appendChild(author);
    }

    const blurb = communityBlurb(story);
    if (blurb) body.appendChild(blurb);
    card.appendChild(body);

    card.addEventListener("click", () => openStoryReader(story.story_id));
    card.addEventListener("keydown", (event) => {
        if (event.target === card && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openStoryReader(story.story_id);
        }
    });
    return card;
}

// The featured slot holds the earliest public story, so it stays put as new
// ones are published; everything else fills the "Recent Stories" grid below
// it, newest first (the order the server sends), so a single published story
// doesn't appear twice.
async function refreshCommunityStories() {
    let stories = [];
    try {
        stories = await storageApi.listCommunityStories();
    } catch (err) {
        stories = [];
    }

    const featured = stories.at(-1);
    const rest = stories.slice(0, -1);
    renderFeatured(featured || null);
    communityStoriesGrid.innerHTML = "";
    for (const story of rest) communityStoriesGrid.appendChild(communityCard(story));
    show(communityStoriesEmpty, Boolean(featured) && rest.length === 0);
}

// The wide card at the top: picture on the left; title, author, summary and
// "Read story" on the right.
function renderFeatured(story) {
    show(featuredStory, Boolean(story));
    show(communityFeaturedEmpty, !story);
    featuredStory.innerHTML = "";
    featuredStory.onclick = null;
    if (!story) return;

    // Until stories can carry a picture of their own, one still on the
    // default gets the scenic image the mock-up used here.
    featuredStory.appendChild(communityCover(story, { fallback: "guangzhou.jpg" }));

    const body = document.createElement("div");
    body.className = "featuredBody";

    const title = document.createElement("h4");
    title.id = "featuredTitle";
    title.textContent = story.title;
    body.appendChild(title);
    body.appendChild(communityAuthor(story));

    const blurb = communityBlurb(story);
    if (blurb) body.appendChild(blurb);

    const actions = document.createElement("div");
    actions.className = "featuredActions";
    const read = document.createElement("button");
    read.type = "button";
    read.className = "readStoryButton";
    read.textContent = "Read story";
    actions.append(read, bookmarkButton(story));
    body.appendChild(actions);
    featuredStory.appendChild(body);

    // Assigned rather than added: #featuredStory is the same element across
    // refreshes, and stacked listeners would each open a story that used to be
    // featured, with whichever request finished last winning. "Read story"
    // bubbles up to this too.
    featuredStory.onclick = () => openStoryReader(story.story_id);
}

// ---- Community cards ----

// Bookmarks are kept in this browser only -- there's no server side for them
// yet -- as a list of story ids under one localStorage key.
const SAVED_STORIES_KEY = "reellife_saved_stories";

function savedStoryIds() {
    try {
        const ids = JSON.parse(localStorage.getItem(SAVED_STORIES_KEY) || "[]");
        return Array.isArray(ids) ? ids.filter(Number.isInteger) : [];
    } catch (err) {
        return [];
    }
}

function setStorySaved(storyId, saved) {
    const ids = savedStoryIds().filter((id) => id !== storyId);
    if (saved) ids.push(storyId);
    try {
        localStorage.setItem(SAVED_STORIES_KEY, JSON.stringify(ids));
    } catch (err) {
        // Storage can be refused (private browsing); the icon still toggles.
    }
}

// The picture at the top (or, featured, the left) of a card. A story still on
// the default avatar gets a soft placeholder -- a square cartoon stretched
// into a wide banner just looks broken -- or `fallback` if one is given.
function communityCover(story, { fallback = null } = {}) {
    const ownPhoto = story.photo && story.photo !== "profile.jpg" ? story.photo : null;
    const src = ownPhoto || fallback;
    if (src) {
        const photo = document.createElement("img");
        photo.className = "communityCover";
        photo.src = src;
        photo.alt = "";
        return photo;
    }
    const placeholder = document.createElement("div");
    placeholder.className = "communityCover communityCoverPlaceholder";
    const icon = document.createElement("ion-icon");
    icon.setAttribute("name", "book-outline");
    icon.setAttribute("aria-hidden", "true");
    placeholder.appendChild(icon);
    return placeholder;
}

// A small round avatar and the author's name. Accounts don't have profile
// pictures yet, so everyone gets the default one.
function communityAuthor(story) {
    const line = document.createElement("p");
    line.className = "communityAuthor";
    const avatar = document.createElement("img");
    avatar.src = "profile.jpg";
    avatar.alt = "";
    const name = document.createElement("span");
    name.className = "author";
    name.textContent = story.author;
    line.append(avatar, name);
    return line;
}

// The summary, or "Place • Time" when there isn't one, so a card isn't left
// with just a title.
function communityBlurb(story) {
    const text = story.summary || settingLine(story)?.textContent;
    if (!text) return null;
    const blurb = document.createElement("p");
    blurb.className = "summary";
    blurb.textContent = text;
    return blurb;
}

// `onChange` runs after the saved state flips.
function bookmarkButton(story, onChange = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bookmarkButton";
    const icon = document.createElement("ion-icon");
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);

    const paint = () => {
        const saved = savedStoryIds().includes(story.story_id);
        icon.setAttribute("name", saved ? "bookmark" : "bookmark-outline");
        button.classList.toggle("saved", saved);
        button.setAttribute("aria-pressed", String(saved));
        button.title = saved ? "Saved" : "Save story";
        button.setAttribute("aria-label", `Save "${story.title}"`);
    };
    paint();

    button.addEventListener("click", (event) => {
        // The card behind it opens the story.
        event.stopPropagation();
        setStorySaved(story.story_id, !savedStoryIds().includes(story.story_id));
        paint();
        if (onChange) onChange();
    });
    return button;
}

// One "Recent Stories" card: picture on top, then the title, the summary, and
// the author with a bookmark beside them.
function communityCard(story) {
    const card = document.createElement("article");
    card.className = "communityCard";
    card.tabIndex = 0;
    card.setAttribute("aria-label", story.title);
    card.appendChild(communityCover(story));

    const body = document.createElement("div");
    body.className = "communityCardBody";

    const title = document.createElement("h4");
    title.textContent = story.title;
    body.appendChild(title);

    const blurb = communityBlurb(story);
    if (blurb) body.appendChild(blurb);

    const footer = document.createElement("div");
    footer.className = "communityCardFooter";
    footer.append(communityAuthor(story), bookmarkButton(story));
    body.appendChild(footer);
    card.appendChild(body);

    card.addEventListener("click", () => openStoryReader(story.story_id));
    card.addEventListener("keydown", (event) => {
        if (event.target === card && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openStoryReader(story.story_id);
        }
    });
    return card;
}

// Called by friends.js too: accepting a request changes what the Friends feed
// should be showing.
function refreshStoryFeeds() {
    refreshMyStories();
    refreshFriendStories();
    refreshCommunityStories();
}

// ---- Reader ----

async function openStoryReader(storyId) {
    let story;
    try {
        story = await storageApi.getStory(storyId);
    } catch (err) {
        alert(errorMessage(err));
        return;
    }

    storyState.readingStory = story;
    storyModalTitle.textContent = story.title;

    storyModalByline.textContent = "";
    storyModalByline.append("By ");
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = story.author;
    storyModalByline.appendChild(author);
    storyModalByline.append(` • ${new Date(story.created_at).toLocaleDateString()}`);

    const setting = settingLine(story);
    storyModalSetting.textContent = setting ? setting.textContent : "";
    show(storyModalSetting, Boolean(setting));

    storyModalTags.innerHTML = "";
    storyModalTags.append(...tagElements(story.tags));
    show(storyModalTags, story.tags.length > 0);

    // One <p> per paragraph rather than one block of text, so a story told
    // over several messages still reads as several paragraphs.
    storyModalContent.innerHTML = "";
    for (const paragraph of story.content.split(/\n{2,}/)) {
        if (!paragraph.trim()) continue;
        const block = document.createElement("p");
        block.textContent = paragraph.trim();
        storyModalContent.appendChild(block);
    }

    show(storyAddFriendBtn, !story.is_author && !story.author_is_friend);
    show(storyModal, true);
}

storyModalCloseBtn.addEventListener("click", () => show(storyModal, false));
storyModal.addEventListener("click", (event) => {
    if (event.target === storyModal) show(storyModal, false);
});

storyAddFriendBtn.addEventListener("click", async () => {
    const story = storyState.readingStory;
    if (!story) return;
    try {
        await storageApi.sendFriendRequest(story.author);
        show(storyAddFriendBtn, false);
        refreshFriendsUi();
    } catch (err) {
        alert(errorMessage(err));
    }
});

// ---- Publishing ----

// Opened from the Story tab. An already-published conversation pre-fills the
// form with its story so the dialog doubles as the edit screen. `draft` is the
// interviewer's write-up from "End": its text replaces the
// story text, and the details it came with (title, summary, place,
// time_period, tags) fill in whatever the published story left blank -- an
// author's own title is never overwritten by a fresh draft.
async function openPublishModal(conversationId, { draft, details, notice = "" } = {}) {
    storyState.publishingConversationId = conversationId;
    show(publishError, false);
    publishNotice.textContent = notice;
    show(publishNotice, Boolean(notice));

    let story = null;
    try {
        story = await storageApi.getConversationStory(conversationId);
    } catch (err) {
        story = null;
    }
    storyState.publishingStory = story;

    publishModalTitle.textContent = story ? "Edit your published story" : "Publish your story";
    publishSubmitBtn.textContent = story ? "Save changes" : "Publish";
    show(unpublishBtn, Boolean(story));

    const drafted = details || {};
    publishTitleInput.value = story?.title || drafted.title || "";
    publishSummaryInput.value = story?.summary || drafted.summary || "";
    publishPlaceInput.value = story?.place || drafted.place || "";
    publishTimePeriodInput.value = story?.time_period || drafted.time_period || "";
    publishTagsInput.value = (story?.tags?.length ? story.tags : drafted.tags || []).join(", ");
    publishVisibilitySelect.value = story?.visibility || "friends";
    // Blank means "use what's in the conversation" -- the server rebuilds the
    // text from the author's messages (see ../stories.js).
    publishContentInput.value = draft || story?.content || (await conversationText(conversationId));

    storyState.publishingSnapshot = publishFormValues();
    storyState.publishingDraft = Boolean(draft);
    show(publishModal, true);
    publishTitleInput.focus();
}

function publishFormValues() {
    return JSON.stringify(
        [
            publishTitleInput,
            publishSummaryInput,
            publishPlaceInput,
            publishTimePeriodInput,
            publishTagsInput,
            publishVisibilitySelect,
            publishContentInput,
        ].map((input) => input.value)
    );
}

// Closing would lose something: edits typed since the dialog opened, or a
// story "End" just wrote that hasn't been published -- there's no tab to
// reopen it from, only End again (another write-up).
function publishFormDirty() {
    if (publishModal.classList.contains("hidden") || storyState.publishingSnapshot === null) return false;
    return storyState.publishingDraft || publishFormValues() !== storyState.publishingSnapshot;
}

// The author's own messages, which is exactly what the server would derive on
// its own -- fetched here so the dialog can show what's about to be published
// and let them edit it first.
async function conversationText(conversationId) {
    try {
        const prompts = await storageApi.getPrompts(conversationId);
        return prompts
            .map((prompt) => prompt.content.trim())
            .filter(Boolean)
            .join("\n\n");
    } catch (err) {
        return "";
    }
}

function closePublishModal() {
    show(publishModal, false);
    storyState.publishingConversationId = null;
    storyState.publishingStory = null;
    storyState.publishingSnapshot = null;
    storyState.publishingDraft = false;
}

// Cancel, a click outside the dialog and Esc all come through here; publishing
// and unpublishing close it directly, since there's nothing left to lose.
function requestClosePublishModal() {
    if (publishFormDirty()) {
        const message = storyState.publishingDraft
            ? "Close without publishing the story the interviewer just wrote? " +
              "To get it back you'd have to press End again, which writes it afresh."
            : "You have unsaved changes to this story. Close without saving them?";
        if (!confirm(message)) return;
    }
    closePublishModal();
}

publishCancelBtn.addEventListener("click", requestClosePublishModal);
publishModal.addEventListener("click", (event) => {
    if (event.target === publishModal) requestClosePublishModal();
});

// Reloading, closing the tab or logging out with edits in the dialog gets the
// browser's own "Leave site?" prompt.
window.addEventListener("beforeunload", (event) => {
    if (publishFormDirty()) event.preventDefault();
});

publishForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const conversationId = storyState.publishingConversationId;
    if (conversationId === null) return;

    publishSubmitBtn.disabled = true;
    try {
        await storageApi.publishStory({
            conversationId,
            title: publishTitleInput.value,
            summary: publishSummaryInput.value,
            content: publishContentInput.value,
            // Split here rather than sending the raw string so an empty box
            // sends [] instead of [""].
            tags: publishTagsInput.value.split(",").map((tag) => tag.trim()).filter(Boolean),
            place: publishPlaceInput.value,
            timePeriod: publishTimePeriodInput.value,
            visibility: publishVisibilitySelect.value,
        });
        closePublishModal();
        await refreshPublishStatus(conversationId);
        refreshStoryFeeds();
    } catch (err) {
        publishError.textContent = errorMessage(err);
        show(publishError, true);
    } finally {
        publishSubmitBtn.disabled = false;
    }
});

unpublishBtn.addEventListener("click", async () => {
    const story = storyState.publishingStory;
    const conversationId = storyState.publishingConversationId;
    if (!story) return;
    if (!confirm(`Unpublish "${story.title}"? Your conversation stays, but nobody else will see the story.`)) return;

    try {
        await storageApi.deleteStory(story.story_id);
        closePublishModal();
        await refreshPublishStatus(conversationId);
        refreshStoryFeeds();
    } catch (err) {
        publishError.textContent = errorMessage(err);
        show(publishError, true);
    }
});

// ---- The Story tab's publish status ----
// There is no publish button on the interview: "End" (testChat.js) writes the
// story and opens the publish dialog, and a published story is edited from
// the "Your Stories" reader (storyReaderEditBtn).

const storyPublishStatus = document.querySelector("#storyPublishStatus");

// Called by testChat.js whenever the selected conversation changes.
async function refreshPublishStatus(conversationId) {
    if (conversationId === null || conversationId === undefined) return;

    let story = null;
    try {
        story = await storageApi.getConversationStory(conversationId);
    } catch (err) {
        story = null;
    }

    if (story) {
        storyPublishStatus.textContent = `Published • ${VISIBILITY_LABELS[story.visibility]}`;
        storyPublishStatus.classList.add("published");
    } else {
        storyPublishStatus.textContent = "Not published";
        storyPublishStatus.classList.remove("published");
    }
}

// Esc closes whichever dialog is open.
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!publishModal.classList.contains("hidden")) requestClosePublishModal();
    if (!storyModal.classList.contains("hidden")) show(storyModal, false);
});

// Feeds are loaded once at startup and refreshed when their tab is opened, so
// a story someone else published shows up without a full page reload.
$("#self").click(refreshMyStories);
$("#friends").click(refreshFriendStories);
$("#community").click(refreshCommunityStories);
refreshStoryFeeds();
