// The Friends tab's people panel: searching for someone, sending/answering
// friend requests, and the friend list itself. The stories grid below it is
// rendered by stories.js -- accepting a request here refreshes it, since a new
// friend's stories should appear straight away.
//
// Usernames come from other accounts, so they go in as textContent, never as
// interpolated HTML (same rule as stories.js).

const friendSearchForm = document.querySelector("#friendSearchForm");
const friendSearchInput = document.querySelector("#friendSearchInput");
const friendSearchResults = document.querySelector("#friendSearchResults");
const friendSearchEmpty = document.querySelector("#friendSearchEmpty");
const friendRequestsBlock = document.querySelector("#friendRequestsBlock");
const friendRequestCount = document.querySelector("#friendRequestCount");
const incomingRequests = document.querySelector("#incomingRequests");
const incomingRequestsEmpty = document.querySelector("#incomingRequestsEmpty");
const outgoingRequests = document.querySelector("#outgoingRequests");
const outgoingRequestsHeading = document.querySelector("#outgoingRequestsHeading");
const friendCount = document.querySelector("#friendCount");
const friendList = document.querySelector("#friendList");
const friendListEmpty = document.querySelector("#friendListEmpty");

// What the search result row offers, per relationship. "none" is the only one
// with an action; the rest just say where things stand.
const RELATIONSHIP_LABELS = {
    friends: "Already friends",
    request_sent: "Request sent",
    request_received: "They asked you -- see requests below",
};

// A row with an avatar, the name (and a smaller note under it) on the left and
// buttons on the right. `actions` is a list of [label, className, handler]; an
// empty list gives a plain name row. Accounts have no profile pictures yet, so
// everyone gets the default one -- and email is never sent to other users, so
// the note is a status line rather than an address.
function personRow(username, actions = [], note = "") {
    const item = document.createElement("li");
    item.className = "personRow";

    const avatar = document.createElement("img");
    avatar.className = "personAvatar";
    avatar.src = "profile.jpg";
    avatar.alt = "";
    item.appendChild(avatar);

    const text = document.createElement("div");
    text.className = "personText";
    const name = document.createElement("span");
    name.className = "personName";
    name.textContent = username;
    text.appendChild(name);
    if (note) {
        const noteEl = document.createElement("span");
        noteEl.className = "personNote";
        noteEl.textContent = note;
        text.appendChild(noteEl);
    }
    item.appendChild(text);

    if (actions.length) {
        const buttons = document.createElement("div");
        buttons.className = "personActions";
        for (const [label, className, handler] of actions) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = className;
            button.textContent = label;
            button.addEventListener("click", handler);
            buttons.appendChild(button);
        }
        item.appendChild(buttons);
    }
    return item;
}

// "Mar 3, 2024" -- the date a request was sent.
function shortDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function friendsError(err) {
    return err?.detail || err?.message || "Something went wrong";
}

// Every action here can change more than one of the three lists (accepting a
// request empties it and fills the friend list), so they all just re-read the
// lot rather than trying to patch individual rows.
async function refreshFriendsUi() {
    await Promise.all([refreshRequests(), refreshFriendList()]);
}

async function refreshRequests() {
    let requests = { incoming: [], outgoing: [] };
    try {
        requests = await storageApi.listFriendRequests();
    } catch (err) {
        requests = { incoming: [], outgoing: [] };
    }

    incomingRequests.innerHTML = "";
    for (const request of requests.incoming) {
        incomingRequests.appendChild(
            personRow(
                request.user.username,
                [
                    ["Accept", "primaryButton", () => respondToRequest(request.friendship_id, "accept")],
                    ["Decline", "secondaryButton", () => respondToRequest(request.friendship_id, "decline")],
                ],
                `Asked ${shortDate(request.created_at)}`
            )
        );
    }
    incomingRequestsEmpty.classList.toggle("hidden", requests.incoming.length > 0);

    // Requests you sent only get a heading (and a list) when there are some,
    // so the panel stays as short as the mock-up's.
    outgoingRequests.innerHTML = "";
    for (const request of requests.outgoing) {
        outgoingRequests.appendChild(
            personRow(
                request.user.username,
                [["Cancel", "secondaryButton", () => removeFriend(request.user)]],
                "Waiting for them to accept"
            )
        );
    }
    outgoingRequestsHeading.classList.toggle("hidden", requests.outgoing.length === 0);

    friendRequestCount.textContent = String(requests.incoming.length);
    // Requests waiting on the user are easy to miss behind a collapsed
    // <details>, so open it for them the first time there are any.
    if (requests.incoming.length > 0) friendRequestsBlock.open = true;
}

async function refreshFriendList() {
    let friends = [];
    try {
        friends = await storageApi.listFriends();
    } catch (err) {
        friends = [];
    }

    friendList.innerHTML = "";
    for (const friend of friends) {
        friendList.appendChild(personRow(friend.username, [["Remove", "secondaryButton", () => removeFriend(friend)]]));
    }
    friendListEmpty.classList.toggle("hidden", friends.length > 0);
    friendCount.textContent = String(friends.length);
}

async function respondToRequest(friendshipId, action) {
    try {
        if (action === "accept") {
            await storageApi.acceptFriendRequest(friendshipId);
        } else {
            await storageApi.declineFriendRequest(friendshipId);
        }
        await refreshFriendsUi();
        await rerunSearch();
        // A new friend brings their stories with them.
        if (action === "accept") refreshStoryFeeds();
    } catch (err) {
        alert(friendsError(err));
    }
}

async function removeFriend(user) {
    if (!confirm(`Remove ${user.username}?`)) return;
    try {
        await storageApi.removeFriend(user.id);
        await refreshFriendsUi();
        await rerunSearch();
        refreshStoryFeeds();
    } catch (err) {
        alert(friendsError(err));
    }
}

async function sendRequest(username) {
    try {
        await storageApi.sendFriendRequest(username);
        await refreshFriendsUi();
        await rerunSearch();
        // Asking someone who had already asked you makes you friends outright,
        // so their stories may have just become visible.
        refreshStoryFeeds();
    } catch (err) {
        alert(friendsError(err));
    }
}

// ---- Search ----

async function runSearch(query) {
    if (!query.trim()) {
        friendSearchResults.innerHTML = "";
        friendSearchEmpty.classList.add("hidden");
        return;
    }

    let results = [];
    try {
        results = await storageApi.searchUsers(query);
    } catch (err) {
        results = [];
    }

    friendSearchResults.innerHTML = "";
    for (const person of results) {
        const actions =
            person.relationship === "none"
                ? [["Add friend", "primaryButton", () => sendRequest(person.username)]]
                : [];
        friendSearchResults.appendChild(
            personRow(person.username, actions, RELATIONSHIP_LABELS[person.relationship] || "")
        );
    }
    friendSearchEmpty.classList.toggle("hidden", results.length > 0);
}

// After any change, the visible results' buttons are stale ("Add friend" on
// someone you just asked), so re-run whatever is in the box.
function rerunSearch() {
    return runSearch(friendSearchInput.value);
}

friendSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(friendSearchInput.value);
});

$("#friends").click(refreshFriendsUi);
refreshFriendsUi();
