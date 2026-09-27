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
    // The story open in the reader, so "Add friend" knows whose it is.
    readingStory: null,
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

function bylineLine(story) {
    const byline = document.createElement("p");
    byline.className = "byAuthor";
    byline.append("By ");
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = story.author;
    byline.appendChild(author);
    return byline;
}

// `className` picks up the existing card styling: .friendStory in the Friends
// grid, .otherStory in the Community grid.
function storyCard(story, className) {
    const card = document.createElement("div");
    card.className = className;

    const photo = document.createElement("img");
    photo.src = story.photo || "profile.jpg";
    photo.alt = "";
    card.appendChild(photo);

    const title = document.createElement("h3");
    title.textContent = story.title;
    card.appendChild(title);

    if (story.tags.length) {
        const tags = document.createElement("p");
        tags.className = "tags";
        tags.append(...tagElements(story.tags));
        card.appendChild(tags);
    }

    const setting = settingLine(story);
    if (setting) card.appendChild(setting);
    card.appendChild(bylineLine(story));

    card.addEventListener("click", () => openStoryReader(story.story_id));
    return card;
}

function renderCards(container, stories, className) {
    container.innerHTML = "";
    for (const story of stories) container.appendChild(storyCard(story, className));
}

// ---- Feeds ----

async function refreshFriendStories() {
    let stories = [];
    try {
        stories = await storageApi.listFriendStories();
    } catch (err) {
        stories = [];
    }
    renderCards(friendStoriesGrid, stories, "friendStory");
    show(friendStoriesEmpty, stories.length === 0);
}

// Newest public story is the featured one; everything older fills the grid
// below it, so a single published story doesn't appear twice.
async function refreshCommunityStories() {
    let stories = [];
    try {
        stories = await storageApi.listCommunityStories();
    } catch (err) {
        stories = [];
    }

    const [featured, ...rest] = stories;
    renderFeatured(featured || null);
    renderCards(communityStoriesGrid, rest, "otherStory");
    show(communityStoriesEmpty, Boolean(featured) && rest.length === 0);
}

function renderFeatured(story) {
    show(featuredStory, Boolean(story));
    show(communityFeaturedEmpty, !story);
    featuredStory.innerHTML = "";
    if (!story) return;

    const photo = document.createElement("img");
    // The featured slot is a wide banner, and the default photo is a square
    // avatar -- stretched across it, it just looks broken. Until stories can
    // carry a picture of their own, a story still on the default gets the
    // scenic image the mock-up used here.
    photo.src = !story.photo || story.photo === "profile.jpg" ? "guangzhou.jpg" : story.photo;
    photo.alt = "";
    featuredStory.appendChild(photo);

    const title = document.createElement("h3");
    title.id = "featuredTitle";
    title.textContent = story.title;
    featuredStory.appendChild(title);

    if (story.tags.length) {
        const tags = document.createElement("p");
        tags.className = "tags";
        tags.append(...tagElements(story.tags));
        featuredStory.appendChild(tags);
    }

    const setting = settingLine(story);
    if (setting) featuredStory.appendChild(setting);

    if (story.summary) {
        const summary = document.createElement("p");
        summary.className = "summary";
        summary.textContent = story.summary;
        featuredStory.appendChild(summary);
    }

    featuredStory.appendChild(bylineLine(story));
    featuredStory.addEventListener("click", () => openStoryReader(story.story_id));
}

// Called by friends.js too: accepting a request changes what the Friends feed
// should be showing.
function refreshStoryFeeds() {
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
// form with its story so the dialog doubles as the edit screen.
async function openPublishModal(conversationId) {
    storyState.publishingConversationId = conversationId;
    show(publishError, false);

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

    publishTitleInput.value = story?.title || "";
    publishSummaryInput.value = story?.summary || "";
    publishPlaceInput.value = story?.place || "";
    publishTimePeriodInput.value = story?.time_period || "";
    publishTagsInput.value = (story?.tags || []).join(", ");
    publishVisibilitySelect.value = story?.visibility || "friends";
    // Blank means "use what's in the conversation" -- the server rebuilds the
    // text from the author's messages (see ../stories.js).
    publishContentInput.value = story?.content || (await conversationText(conversationId));

    show(publishModal, true);
    publishTitleInput.focus();
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
}

publishCancelBtn.addEventListener("click", closePublishModal);
publishModal.addEventListener("click", (event) => {
    if (event.target === publishModal) closePublishModal();
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

// ---- The Story tab's publish bar ----

const storyPublishStatus = document.querySelector("#storyPublishStatus");
const publishStoryBtn = document.querySelector("#publishStoryBtn");

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
        publishStoryBtn.textContent = "Edit publication";
    } else {
        storyPublishStatus.textContent = "Not published";
        storyPublishStatus.classList.remove("published");
        publishStoryBtn.textContent = "Publish story";
    }
}

publishStoryBtn.addEventListener("click", () => {
    if (testState.selectedConversationId === null) return;
    openPublishModal(testState.selectedConversationId);
});

// Esc closes whichever dialog is open.
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!publishModal.classList.contains("hidden")) closePublishModal();
    if (!storyModal.classList.contains("hidden")) show(storyModal, false);
});

// Feeds are loaded once at startup and refreshed when their tab is opened, so
// a story someone else published shows up without a full page reload.
$("#friends").click(refreshFriendStories);
$("#community").click(refreshCommunityStories);
refreshStoryFeeds();
