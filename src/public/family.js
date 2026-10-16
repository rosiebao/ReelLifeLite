// "Family" tab.
//
// Your family tree, drawn one generation per band (grandparents at the top),
// beside a panel for whoever is selected: their details and, for someone not
// on ReelLife yet, an invitation. It's loaded from and saved back to the
// logged-in user's tree on the server (GET/PUT /family, see ../family.js), so
// it follows the account rather than the browser.
//
// The model mirrors the API payload:
//   { rows: [ { members: [ { member_id, name, photo, photo_url, is_self,
//       relationship, email, status, invited_at, linked_user, parents } ] } ] }
// Row 1 is the top of the tree. member_id is null for someone added here and
// not saved yet. status comes from the server: "self", "joined" (linked to a
// ReelLife account), "invited" or "not_invited". `parents` are this member's
// parents as positions in the row directly above; the tree's lines join
// exactly those (see "Connector lines").
//
// Names and relationships are typed by the user and usernames come from other
// accounts, so all of it goes in as textContent, never as HTML.

const DEFAULT_MEMBER_PHOTO = "profile.jpg";
const DEFAULT_MEMBER_NAME = "Unnamed";
const SVG_NS = "http://www.w3.org/2000/svg";

// index.html?invite=<token> is an invitation link. authGuard.js keeps the
// token under this key while a signed-out visitor goes to sign in first.
const FAMILY_INVITE_PARAM = "invite";
const PENDING_INVITE_KEY = "reellife_pending_invite";

// What a brand-new account starts with: two generations above you, and a
// sibling to show where brothers and sisters go. Mom's parents are the first
// two grandparents and Dad's the other two.
const STARTING_TREE = {
    rows: [
        {
            members: [
                { name: "Grandma", relationship: "Mom's mother" },
                { name: "Grandpa", relationship: "Mom's father" },
                { name: "Grandma", relationship: "Dad's mother" },
                { name: "Grandpa", relationship: "Dad's father" },
            ],
        },
        {
            members: [
                { name: "Mom", relationship: "Mother", parents: [0, 1] },
                { name: "Dad", relationship: "Father", parents: [2, 3] },
            ],
        },
        {
            members: [
                { name: "Me", is_self: true, parents: [0, 1] },
                { name: "Sister", relationship: "Sister", parents: [0, 1] },
            ],
        },
    ],
};

const STATUS_LABELS = {
    self: "You",
    joined: "On ReelLife",
    invited: "Invited",
    not_invited: "Not invited",
};

const familyEls = {
    tree: document.querySelector("#familyTree"),
    reset: document.querySelector("#resetTree"),
    detail: document.querySelector("#familyDetail"),
    memberCount: document.querySelector("#familyMemberCount"),
    memberList: document.querySelector("#familyMemberList"),
    addMember: document.querySelector("#addFamilyMemberBtn"),
    invite: document.querySelector("#inviteFamilyBtn"),
    modal: document.querySelector("#familyMemberModal"),
    modalTitle: document.querySelector("#familyModalTitle"),
    modalIntro: document.querySelector("#familyModalIntro"),
    form: document.querySelector("#familyMemberForm"),
    friendField: document.querySelector("#familyFriendField"),
    friendSelect: document.querySelector("#familyFriendSelect"),
    friendEmpty: document.querySelector("#familyFriendEmpty"),
    name: document.querySelector("#familyNameInput"),
    relationship: document.querySelector("#familyRelationshipInput"),
    generationField: document.querySelector("#familyGenerationField"),
    generation: document.querySelector("#familyGenerationSelect"),
    relatedField: document.querySelector("#familyRelatedField"),
    relatedTo: document.querySelector("#familyRelatedToSelect"),
    relatedAs: document.querySelector("#familyRelatedAsSelect"),
    emailField: document.querySelector("#familyEmailField"),
    email: document.querySelector("#familyEmailInput"),
    modeSwitch: document.querySelector("#familyModalSwitch"),
    modalError: document.querySelector("#familyModalError"),
    modalCancel: document.querySelector("#familyModalCancel"),
    modalSubmit: document.querySelector("#familyModalSubmit"),
    inviteModal: document.querySelector("#familyInviteModal"),
    inviteText: document.querySelector("#familyInviteText"),
    inviteAccept: document.querySelector("#familyInviteAccept"),
    inviteDismiss: document.querySelector("#familyInviteDismiss"),
};

// What's on screen. Edits land here first and are saved immediately after.
let familyTree = { rows: [] };

// The last tree the server confirmed. An edit is drawn before it's saved, so
// this is what the page falls back to when a save can't be completed.
let lastSavedTree = { rows: [] };

let familyLoaded = false;

// One save at a time, and no edits while it's out: the server's reply
// replaces the whole tree, which would quietly drop an edit made meanwhile.
let familySaveInFlight = false;

// Whose details the panel shows, by member_id.
let selectedMemberId = null;

// A line under the panel's buttons ("Link copied"), for one member only.
let detailMessage = null;

// ---- Model ----

function normalizeMember(member) {
    const isSelf = Boolean(member?.is_self);
    const photo = String(member?.photo ?? "").trim() || DEFAULT_MEMBER_PHOTO;
    const linkedId = Number(member?.linked_user?.id);
    const linkedUser =
        !isSelf && Number.isInteger(linkedId) && linkedId > 0
            ? { id: linkedId, username: String(member.linked_user.username ?? "") }
            : null;

    let status = member?.status;
    if (isSelf) status = "self";
    else if (!["joined", "invited", "not_invited"].includes(status)) status = linkedUser ? "joined" : "not_invited";

    return {
        member_id: Number.isInteger(member?.member_id) ? member.member_id : null,
        name: String(member?.name ?? "").trim() || DEFAULT_MEMBER_NAME,
        photo,
        photo_url: String(member?.photo_url ?? "").trim() || photo,
        is_self: isSelf,
        relationship: String(member?.relationship ?? "").trim(),
        email: String(member?.email ?? "").trim(),
        status,
        invited_at: member?.invited_at || null,
        linked_user: linkedUser,
        // Kept as given here; normalizeFamilyTree drops any that don't point
        // at someone in the row above.
        parents: Array.isArray(member?.parents) ? member.parents.filter(Number.isInteger) : [],
    };
}

// Copies a tree and drops anything unexpected, so a surprising payload (or a
// caller's object) can't break rendering or be changed by accident.
function normalizeFamilyTree(raw) {
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];
    const tree = {
        rows: rows.map((row) => ({
            members: (Array.isArray(row?.members) ? row.members : []).map(normalizeMember),
        })),
    };
    tree.rows.forEach((row, rowIndex) => {
        const above = rowIndex > 0 ? tree.rows[rowIndex - 1].members.length : 0;
        for (const member of row.members) {
            member.parents = [...new Set(member.parents)].filter((index) => index >= 0 && index < above);
        }
    });
    return tree;
}

// What PUT /family takes. Parents are sent as positions in the row above,
// which also covers members who don't have an id yet.
function treePayload(tree) {
    return {
        rows: tree.rows.map((row) => ({
            members: row.members.map((member) => ({
                member_id: member.member_id,
                name: member.name,
                photo: member.photo,
                is_self: member.is_self,
                relationship: member.relationship,
                email: member.email,
                linked_user_id: member.linked_user?.id ?? null,
                parents: member.parents,
            })),
        })),
    };
}

function getFamilyTree() {
    return familyTree;
}

// Every member with where they sit, top generation first.
function allFamilyMembers() {
    return familyTree.rows.flatMap((row, rowIndex) =>
        row.members.map((member, memberIndex) => ({ member, rowIndex, memberIndex }))
    );
}

function findFamilyMember(memberId) {
    if (memberId === null || memberId === undefined) return null;
    return allFamilyMembers().find((entry) => entry.member.member_id === memberId) || null;
}

function selfRowIndex() {
    return familyTree.rows.findIndex((row) => row.members.some((member) => member.is_self));
}

// Generations are named from where you are; without a "you" they're numbered.
function generationLabel(rowIndex) {
    const selfRow = selfRowIndex();
    if (selfRow < 0) return `Generation ${rowIndex + 1}`;
    const distance = rowIndex - selfRow;
    if (distance === 0) return "Your generation";
    if (distance === -1) return "Parents";
    if (distance === 1) return "Children";
    const greats = "great-".repeat(Math.abs(distance) - 2);
    const label = `${greats}${distance < 0 ? "grandparents" : "grandchildren"}`;
    return label.charAt(0).toUpperCase() + label.slice(1);
}

// The panel shows the chosen member, or you, or whoever comes first.
function selectedFamilyEntry() {
    const chosen = findFamilyMember(selectedMemberId);
    if (chosen) return chosen;
    const entries = allFamilyMembers();
    return entries.find((entry) => entry.member.is_self) || entries[0] || null;
}

function displayName(member) {
    return member.is_self ? "You" : member.name;
}

// "Sister" -> "Your sister", for the panel under someone's name.
function relationshipPhrase(member, rowIndex) {
    if (member.is_self) return member.relationship || generationLabel(rowIndex);
    if (!member.relationship) return generationLabel(rowIndex);
    return `Your ${member.relationship.charAt(0).toLowerCase()}${member.relationship.slice(1)}`;
}

function isEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+$/.test(value);
}

function shortFamilyDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function familyErrorText(err) {
    // fetch() rejects with a TypeError when it never reached the server at all
    // -- "Failed to fetch" on its own doesn't say that, so spell it out.
    if (err instanceof TypeError) {
        return "the server isn't responding. Check that it's still running, then try again";
    }
    return err?.detail || err?.message || "unknown error";
}

function handleFamilyError(err, action) {
    if (err?.status === 401) {
        window.location.replace("login.html");
        return;
    }
    alert(`Could not ${action}: ${familyErrorText(err)}.`);
}

// ---- Server ----

// Only an account that has never saved a tree gets the starting layout. A
// tree that was deliberately emptied comes back with `seeded` set, and is
// left empty.
async function loadFamilyTree() {
    const payload = await storageApi.getFamily();
    const stored = treeFromServer(payload);
    if (payload?.seeded || stored.rows.length > 0) return stored;
    return treeFromServer(await storageApi.saveFamily(treePayload(normalizeFamilyTree(STARTING_TREE))));
}

// A tree saved before parents were recorded has none. Until its next save
// they're worked out the way its lines used to be drawn: the people in a
// generation taken in pairs (1-2, 3-4, ...) as couples, and the generation
// below shared out among those couples in order.
function guessParents(tree) {
    tree.rows.forEach((row, rowIndex) => {
        if (rowIndex === 0) return;
        const above = tree.rows[rowIndex - 1].members.length;
        const couples = Math.ceil(above / 2);
        if (couples === 0) return;
        row.members.forEach((member, childIndex) => {
            const couple = Math.floor((childIndex * couples) / row.members.length);
            member.parents = [couple * 2, couple * 2 + 1].filter((index) => index < above);
        });
    });
    return tree;
}

function treeFromServer(payload) {
    const tree = normalizeFamilyTree(payload);
    return payload?.parents_saved ? tree : guessParents(tree);
}

// Pulls the server's copy in and draws it.
async function refreshFamilyTree() {
    familyTree = await loadFamilyTree();
    lastSavedTree = normalizeFamilyTree(familyTree);
    familyLoaded = true;
    renderFamilyPage();
    return familyTree;
}

// Draws the change straight away, then saves it. If the save fails the page is
// put back to what the server actually holds, so a change that wasn't saved
// never sits on screen looking like it was. Returns whether it saved.
async function persistFamilyTree(action) {
    familySaveInFlight = true;
    renderFamilyPage();
    let saved = false;
    try {
        familyTree = treeFromServer(await storageApi.saveFamily(treePayload(familyTree)));
        saved = true;
    } catch (err) {
        handleFamilyError(err, action);
        try {
            familyTree = treeFromServer(await storageApi.getFamily());
        } catch (refetchErr) {
            // Can't reach the server to ask, so undo the change instead.
            familyTree = normalizeFamilyTree(lastSavedTree);
        }
    }
    lastSavedTree = normalizeFamilyTree(familyTree);
    familySaveInFlight = false;
    renderFamilyPage();
    return saved;
}

// Runs an edit to the model and saves it -- unless the tree hasn't loaded or
// another save is still out, in which case the click is ignored.
async function editFamilyTree(action, change) {
    if (!familyLoaded || familySaveInFlight) return false;
    if (withParentRefs(change) === false) return false;
    return persistFamilyTree(action);
}

// Parents are stored as positions in the row above, which an edit (someone
// removed or moved, a generation added) shifts. So for the length of one
// edit each member holds `parentRefs` -- the parent members themselves --
// and afterwards those are turned back into positions. A parent who is no
// longer in the row directly above (removed, or a generation now between
// them) is dropped. Members created during the edit can set `parentRefs`
// themselves; ones with none (a reset tree, a new generation) keep their
// `parents` as they are.
function withParentRefs(change) {
    familyTree.rows.forEach((row, rowIndex) => {
        const above = rowIndex > 0 ? familyTree.rows[rowIndex - 1].members : [];
        for (const member of row.members) {
            member.parentRefs = member.parents.map((index) => above[index]).filter(Boolean);
        }
    });
    try {
        return change();
    } finally {
        familyTree.rows.forEach((row, rowIndex) => {
            const above = rowIndex > 0 ? familyTree.rows[rowIndex - 1].members : [];
            for (const member of row.members) {
                if (member.parentRefs !== undefined) {
                    const positions = member.parentRefs.map((parent) => above.indexOf(parent));
                    member.parents = [...new Set(positions.filter((index) => index >= 0))].slice(0, FAMILY_MAX_PARENTS);
                }
                delete member.parentRefs;
            }
        });
    }
}

// Matches MAX_PARENTS in ../family.js.
const FAMILY_MAX_PARENTS = 4;

// Everyone who shares a child with `member` (their partners, as far as the
// tree knows). Only valid inside withParentRefs.
function coParentsOf(member) {
    const partners = new Set();
    for (const { member: other } of allFamilyMembers()) {
        if (other.parentRefs?.includes(member)) {
            for (const parent of other.parentRefs) if (parent !== member) partners.add(parent);
        }
    }
    return [...partners];
}

// Joins someone just added to the person they were added next to ("Related
// to ... As their ..."), so the tree's lines go where they should:
//   parent  -- they become one of that person's parents
//   child   -- that person (and anyone they've had children with) are theirs
//   sibling -- they get the same parents
//   partner -- they become a parent of that person's children too
// Inside withParentRefs; links that don't fit the generations chosen are
// dropped there.
function linkNewMember(draft, anchor, kind) {
    if (!anchor) return;
    const addParent = (child, parent) => {
        if (!child.parentRefs.includes(parent)) child.parentRefs.push(parent);
    };
    if (kind === "parent") addParent(anchor, draft);
    else if (kind === "child") draft.parentRefs = [anchor, ...coParentsOf(anchor)];
    else if (kind === "sibling") draft.parentRefs = [...anchor.parentRefs];
    else if (kind === "spouse") {
        for (const { member } of allFamilyMembers()) {
            if (member !== draft && member.parentRefs?.includes(anchor)) addParent(member, draft);
        }
    }
}

// Moves someone just added (last in row `rowIndex`) next to the people they
// belong with, so their lines stay short: a partner or sibling right after
// the person they were added to, a child among the children of the same
// parents (ordered as the parents are), a parent beside that person's other
// parents. Anything else stays at the end of the row. Inside withParentRefs.
function placeNewMember(rowIndex, draft, anchor, kind) {
    const members = familyTree.rows[rowIndex].members;
    const above = rowIndex > 0 ? familyTree.rows[rowIndex - 1].members : [];
    // Where someone's parents sit in the row above, on average.
    const parentSpot = (member) => {
        const spots = (member.parentRefs || []).map((parent) => above.indexOf(parent)).filter((i) => i >= 0);
        return spots.length ? spots.reduce((sum, i) => sum + i, 0) / spots.length : null;
    };

    let at = -1;
    if ((kind === "spouse" || kind === "sibling") && members.includes(anchor)) {
        at = members.indexOf(anchor) + 1;
    } else if (kind === "child") {
        const mine = parentSpot(draft);
        if (mine !== null) {
            const later = members.findIndex((member) => member !== draft && (parentSpot(member) ?? -1) > mine);
            if (later !== -1) at = later;
        }
    } else if (kind === "parent") {
        const others = members.filter((member) => member !== draft && anchor?.parentRefs?.includes(member));
        if (others.length) at = Math.max(...others.map((member) => members.indexOf(member))) + 1;
    }
    if (at === -1) return;
    members.splice(members.indexOf(draft), 1);
    members.splice(Math.min(at, members.length), 0, draft);
}

// ---- Members ----

// `details` is { name, relationship, email, linked_user }. `rowIndex` is a
// generation, or -1 / rows.length for a new one above / below the tree
// (created in the same save). `relation` ({ anchorId, kind }) is who they
// were added next to and how, for the parent links. Returns the saved
// member, or null.
async function addFamilyMember(rowIndex, details = {}, relation = null) {
    if (!Number.isInteger(rowIndex) || rowIndex < -1 || rowIndex > familyTree.rows.length) return null;
    const draft = normalizeMember({ ...details, is_self: false, member_id: null });
    let target = rowIndex;
    const saved = await editFamilyTree("add that family member", () => {
        if (target === -1) {
            familyTree.rows.unshift({ members: [] });
            target = 0;
        } else if (target === familyTree.rows.length) {
            familyTree.rows.push({ members: [] });
        }
        draft.parentRefs = [];
        familyTree.rows[target].members.push(draft);
        if (relation) {
            const anchor = findFamilyMember(relation.anchorId)?.member;
            linkNewMember(draft, anchor, relation.kind);
            placeNewMember(target, draft, anchor, relation.kind);
        }
    });
    if (!saved) return null;
    // The server gave the new member an id; it's the last one in that row.
    const added = familyTree.rows[target]?.members.at(-1) || null;
    if (added) selectedMemberId = added.member_id;
    renderFamilyPage();
    return added;
}

async function updateFamilyMember(memberId, changes) {
    const entry = findFamilyMember(memberId);
    if (!entry) return false;
    return editFamilyTree("save those details", () => {
        Object.assign(entry.member, changes);
    });
}

// You can't remove yourself from your own family tree. The button isn't drawn
// for that member, and this guard covers anything calling it directly.
async function removeFamilyMember(rowIndex, memberIndex) {
    const member = familyTree.rows[rowIndex]?.members[memberIndex];
    if (!member || member.is_self) return false;
    return editFamilyTree("remove that family member", () => {
        familyTree.rows[rowIndex].members.splice(memberIndex, 1);
        if (selectedMemberId === member.member_id) selectedMemberId = null;
    });
}

// ---- Generations ----

// Inserts a generation at `index`, pushing the ones below it down. Index 0
// puts it at the top of the tree; familyTree.rows.length adds it at the bottom.
function insertFamilyRow(index, members = []) {
    return editFamilyTree("add that generation", () => {
        const position = Math.max(0, Math.min(index, familyTree.rows.length));
        familyTree.rows.splice(position, 0, normalizeFamilyTree({ rows: [{ members }] }).rows[0]);
    });
}

function removeFamilyRowAt(index) {
    if (!familyTree.rows[index]) return false;
    return editFamilyTree("remove that generation", () => {
        familyTree.rows.splice(index, 1);
    });
}

// The whole-tree shortcuts familyStore exposes.
function addFamilyRow(members) {
    return insertFamilyRow(familyTree.rows.length, members);
}

function removeFamilyRow() {
    return removeFamilyRowAt(familyTree.rows.length - 1);
}

// Throws away the saved tree and goes back to the starting layout.
function resetFamilyTree() {
    return editFamilyTree("reset the family tree", () => {
        familyTree = normalizeFamilyTree(STARTING_TREE);
        selectedMemberId = null;
    });
}

// Asks before dropping a whole generation of people. An empty one goes
// without a question; one holding you says so explicitly.
function confirmRowRemoval(row, rowIndex) {
    const label = generationLabel(rowIndex);
    if (row.members.some((member) => member.is_self)) {
        return confirm(`"${label}" includes you. Remove it anyway?`);
    }
    if (row.members.length > 0) {
        const count = row.members.length;
        return confirm(`Remove "${label}" and the ${count} ${count === 1 ? "person" : "people"} in it?`);
    }
    return true;
}

function confirmMemberRemoval(member) {
    const invited = member.status === "invited" ? " Their invitation link will stop working." : "";
    return confirm(`Remove ${member.name} from your family tree?${invited}`);
}

// ---- Rendering helpers ----

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name) {
    const node = document.createElement("ion-icon");
    node.setAttribute("name", name);
    node.setAttribute("aria-hidden", "true");
    return node;
}

function avatarImg(member, className) {
    const img = el("img", className);
    img.src = member.photo_url || DEFAULT_MEMBER_PHOTO;
    img.alt = "";
    // A linked account's photo that's gone missing falls back to the default.
    img.addEventListener("error", () => {
        if (!img.src.endsWith(DEFAULT_MEMBER_PHOTO)) img.src = DEFAULT_MEMBER_PHOTO;
    });
    return img;
}

function statusBadge(member) {
    return el("span", `familyStatus ${member.status}`, STATUS_LABELS[member.status]);
}

function controlButton(iconName, label, description, onClick, { disabled = false } = {}) {
    const button = el("button", "familyRowButton");
    button.type = "button";
    button.title = description;
    button.setAttribute("aria-label", description);
    button.append(icon(iconName), el("span", "", label));
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
}

// ---- The tree ----

// On a card the pill is only for people you're inviting (you gave an email,
// or sent the link), so a tree full of grandparents isn't a wall of red. The
// panel and the Members list always say where everyone stands.
function showsCardStatus(member) {
    return member.status === "invited" || (member.status === "not_invited" && Boolean(member.email));
}

function memberCard(member, rowIndex, compact, memberIndex) {
    const card = el("button", "familyCard");
    card.type = "button";
    card.dataset.memberId = member.member_id ?? "";
    // Where they sit in their row, which is what `parents` refers to.
    card.dataset.index = String(memberIndex);
    card.classList.toggle("compact", compact);
    card.classList.toggle("isSelf", member.is_self);
    const selected = selectedFamilyEntry()?.member === member;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
    card.setAttribute("aria-label", `${displayName(member)}, ${relationshipPhrase(member, rowIndex)}`);

    const text = el("span", "familyCardText");
    text.append(el("span", "familyCardName", displayName(member)));
    if (member.relationship) text.append(el("span", "familyCardRelation", member.relationship));
    if (showsCardStatus(member)) text.append(statusBadge(member));

    card.append(avatarImg(member, "familyCardPhoto"), text);
    card.addEventListener("click", () => selectFamilyMember(member.member_id));
    return card;
}

// The buttons beside each generation: add someone to it, remove the selected
// person from it, add a generation above or below, or remove this one.
function rowControls(rowIndex, row) {
    const selected = selectedFamilyEntry();
    const canRemove = selected && selected.rowIndex === rowIndex && !selected.member.is_self;
    const label = generationLabel(rowIndex);
    const controls = el("div", "familyRowControls");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `${label} controls`);

    controls.append(
        // Most people added to a generation (grandparents, say) aren't on
        // ReelLife, so this asks for a name; the dialog links to the friend
        // picker for those who are.
        controlButton("person-add-outline", "Member", `Add someone to ${label}`, () =>
            openFamilyModal("new", { rowIndex })
        ),
        controlButton(
            "person-remove-outline",
            "Member",
            canRemove ? `Remove ${selected.member.name}` : `Select someone in ${label} to remove them`,
            () => {
                if (!confirmMemberRemoval(selected.member)) return;
                removeFamilyMember(selected.rowIndex, selected.memberIndex);
            },
            { disabled: !canRemove }
        ),
        controlButton("arrow-up-outline", "+ Layer", `Add a generation above ${label}`, () =>
            insertFamilyRow(rowIndex)
        ),
        controlButton("arrow-down-outline", "+ Layer", `Add a generation below ${label}`, () =>
            insertFamilyRow(rowIndex + 1)
        ),
        controlButton("close-outline", "Layer", `Remove ${label}`, () => {
            if (!confirmRowRemoval(row, rowIndex)) return;
            removeFamilyRowAt(rowIndex);
        })
    );
    return controls;
}

// One generation: its people on a single line -- the row never wraps, however
// many there are; the tree scrolls sideways instead -- and, pinned to the
// right edge of the tree as it scrolls, the generation's name and controls.
// Cards keep their full size.
function familyBand(row, rowIndex) {
    const band = el("div", "familyBand");
    band.dataset.row = String(rowIndex);
    band.classList.toggle("isSelfRow", row.members.some((member) => member.is_self));

    const members = el("div", "familyBandMembers");
    row.members.forEach((member, memberIndex) => members.append(memberCard(member, rowIndex, false, memberIndex)));
    if (row.members.length === 0) {
        const add = el("button", "familyBandEmpty", "No one here yet -- add someone");
        add.type = "button";
        add.addEventListener("click", () => openFamilyModal("new", { rowIndex }));
        members.append(add);
    }

    const side = el("div", "familyBandSide");
    side.append(el("span", "familyBandLabel", generationLabel(rowIndex)), rowControls(rowIndex, row));
    band.append(members, side);
    return band;
}

function renderEmptyFamilyTree() {
    const empty = el("div", "familyTreeEmpty");
    empty.append(el("p", "", "Your family tree is empty."));
    const add = el("button", "familyPrimaryButton", "Add a generation");
    add.type = "button";
    add.addEventListener("click", () => insertFamilyRow(0));
    empty.append(add);
    familyEls.tree.append(empty);
}

// All the generations sit in one scroller, so they scroll sideways together
// and the lines between them stay joined.
function renderFamilyTreeBands() {
    // Keep the sideways scroll across a redraw (selecting someone, a save).
    const previousScroll = familyEls.tree.querySelector(".familyTreeScroll")?.scrollLeft ?? 0;
    familyEls.tree.innerHTML = "";
    familyEls.tree.classList.toggle("saving", familySaveInFlight);
    familyEls.tree.setAttribute("aria-busy", String(familySaveInFlight || !familyLoaded));
    if (familyTree.rows.length === 0) {
        renderEmptyFamilyTree();
        return;
    }

    const scroll = el("div", "familyTreeScroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Family tree -- scroll sideways to see everyone");
    const canvas = el("div", "familyTreeCanvas");
    const lines = document.createElementNS(SVG_NS, "svg");
    lines.classList.add("familyLines");
    lines.setAttribute("aria-hidden", "true");
    canvas.append(lines);
    familyTree.rows.forEach((row, rowIndex) => canvas.append(familyBand(row, rowIndex)));
    scroll.append(canvas);
    familyEls.tree.append(scroll);
    scroll.scrollLeft = previousScroll;
    layoutFamilyTree();
}

// Run whenever the tree is drawn or changes size.
function layoutFamilyTree() {
    centerFamilyTreeOnSelf();
    drawFamilyLines();
}

// The first time the tree can be seen, scroll it sideways so your own card is
// in the middle -- in a wide family you might otherwise start off-screen.
// After that the tree stays wherever it's been scrolled to.
let familyTreeCentered = false;
function centerFamilyTreeOnSelf() {
    if (familyTreeCentered) return;
    const scroll = familyEls.tree.querySelector(".familyTreeScroll");
    if (!scroll || scroll.clientWidth === 0) return; // hidden: tried again when the tab opens
    familyTreeCentered = true;
    const self = scroll.querySelector(".familyCard.isSelf");
    if (!self || scroll.scrollWidth <= scroll.clientWidth) return;
    const side = scroll.querySelector(".familyBandSide")?.offsetWidth ?? 0;
    const visible = scroll.clientWidth - side;
    const cardMiddle = self.getBoundingClientRect().left - scroll.getBoundingClientRect().left + scroll.scrollLeft + self.offsetWidth / 2;
    scroll.scrollLeft = Math.max(0, cardMiddle - visible / 2);
}

// ---- Connector lines ----
//
// Each person is joined to their own parents (`parents` in the model) -- and
// only that: no lines between partners or siblings. A child's parents are
// joined by a short bar under them, a line drops from its middle to a rail
// halfway down to the next generation, and from the rail a line drops to
// each of their children. Children of the same set of parents share one rail.
// Someone with one parent in the tree hangs from that parent alone.

function svgLine(svg, x1, y1, x2, y2) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    svg.append(line);
}

// Where a card sits within the tree's canvas (which is what scrolls), so the
// lines line up however far it's been scrolled.
function cardBox(card, origin) {
    const rect = card.getBoundingClientRect();
    return {
        left: rect.left - origin.left,
        right: rect.right - origin.left,
        top: rect.top - origin.top,
        bottom: rect.bottom - origin.top,
        centerX: rect.left - origin.left + rect.width / 2,
    };
}

// Gathers each row's children by their set of parents: [{ parents: [boxes],
// children: [boxes] }], so brothers and sisters share one line down.
function parentGroups(rowIndex, boxesPerRow) {
    const groups = new Map();
    const above = boxesPerRow[rowIndex - 1] || [];
    familyTree.rows[rowIndex].members.forEach((member, memberIndex) => {
        const child = boxesPerRow[rowIndex][memberIndex];
        const parents = member.parents.filter((index) => above[index]);
        if (!child || parents.length === 0) return;
        const key = [...parents].sort((a, b) => a - b).join(",");
        if (!groups.has(key)) groups.set(key, { parents: parents.map((index) => above[index]), children: [] });
        groups.get(key).children.push(child);
    });
    return [...groups.values()];
}

function drawFamilyLines() {
    const canvas = familyEls.tree.querySelector(".familyTreeCanvas");
    const svg = canvas?.querySelector(".familyLines");
    if (!svg) return;
    svg.innerHTML = "";
    const origin = canvas.getBoundingClientRect();
    if (origin.width === 0) return;
    svg.setAttribute("width", canvas.scrollWidth);
    svg.setAttribute("height", canvas.scrollHeight);

    // Cards by [row][position], matching the model.
    const boxesPerRow = [...canvas.querySelectorAll(".familyBand")].map((band) => {
        const boxes = [];
        band.querySelectorAll(".familyCard").forEach((card) => {
            boxes[Number(card.dataset.index)] = cardBox(card, origin);
        });
        return boxes;
    });

    familyTree.rows.forEach((row, rowIndex) => {
        if (rowIndex === 0 || !boxesPerRow[rowIndex]) return;
        const groups = parentGroups(rowIndex, boxesPerRow);
        // Groups that would share a rail are staggered, so two families'
        // lines never run along each other.
        const parentsBottom = Math.max(...(boxesPerRow[rowIndex - 1] || []).filter(Boolean).map((box) => box.bottom));
        const childrenTop = Math.min(...boxesPerRow[rowIndex].filter(Boolean).map((box) => box.top));
        const gap = childrenTop - parentsBottom;
        groups.forEach((group, groupIndex) => {
            const offset = groups.length > 1 ? ((groupIndex + 1) / (groups.length + 1) - 0.5) * gap * 0.5 : 0;
            const railY = parentsBottom + gap / 2 + offset;
            const parentXs = group.parents.map((box) => box.centerX);
            const parentBottom = Math.max(...group.parents.map((box) => box.bottom));
            // Each parent drops to a bar just under them; the family's line
            // goes down from the middle of that bar.
            const barY = parentBottom + Math.min(12, (railY - parentBottom) / 2);
            group.parents.forEach((box) => svgLine(svg, box.centerX, box.bottom, box.centerX, barY));
            if (parentXs.length > 1) svgLine(svg, Math.min(...parentXs), barY, Math.max(...parentXs), barY);
            const dropX = (Math.min(...parentXs) + Math.max(...parentXs)) / 2;
            svgLine(svg, dropX, barY, dropX, railY);

            const childXs = group.children.map((box) => box.centerX);
            const xs = [dropX, ...childXs];
            svgLine(svg, Math.min(...xs), railY, Math.max(...xs), railY);
            group.children.forEach((box) => svgLine(svg, box.centerX, railY, box.centerX, box.top));
        });
    });
}

// Cards move whenever the page is resized or the icon font arrives.
if (familyEls.tree && "ResizeObserver" in window) {
    new ResizeObserver(() => layoutFamilyTree()).observe(familyEls.tree);
}

// ---- The detail panel ----

function inviteLinkFor(token) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set(FAMILY_INVITE_PARAM, token);
    return url.toString();
}

function infoNote(text) {
    const note = el("p", "familyNote");
    note.append(icon("information-circle-outline"), el("span", "", text));
    return note;
}

function panelButton(className, iconName, label, onClick) {
    const button = el("button", className);
    button.type = "button";
    if (iconName) button.append(icon(iconName));
    button.append(el("span", "", label));
    button.addEventListener("click", onClick);
    return button;
}

function detailInviteSection(member) {
    const section = el("div", "familyDetailInvite");
    const firstName = member.name.split(" ")[0];
    section.append(
        el(
            "p",
            "familyDetailText",
            member.status === "invited"
                ? `You invited ${firstName}${member.invited_at ? ` on ${shortFamilyDate(member.invited_at)}` : ""}. ` +
                      "Send it again, or share the link another way."
                : `Invite ${firstName} to join ReelLife and build your family story together.`
        )
    );

    const label = el("label", "familyField");
    label.append(el("span", "", "Email address"));
    const email = el("input");
    email.type = "email";
    email.autocomplete = "off";
    email.placeholder = "name@example.com";
    email.value = member.email;
    label.append(email);
    section.append(label);

    const error = el("p", "familyError hidden");
    error.setAttribute("role", "alert");
    section.append(
        error,
        panelButton(
            "familyPrimaryButton",
            "mail-outline",
            member.status === "invited" ? "Send again" : "Send invitation",
            () => sendInvitation(member, email.value.trim(), error)
        ),
        panelButton("familySecondaryButton", "link-outline", "Copy invite link", () => copyInviteLink(member, error))
    );
    if (detailMessage?.memberId === member.member_id) {
        section.append(el("p", "familyDetailMessage", detailMessage.text));
    }
    section.append(infoNote("Confirm your place in the tree after joining."));
    return section;
}

function renderFamilyDetail() {
    const panel = familyEls.detail;
    panel.innerHTML = "";
    const entry = selectedFamilyEntry();
    if (!entry) {
        panel.append(el("p", "familyDetailText", "Add someone to your tree to see their details here."));
        return;
    }
    const { member, rowIndex, memberIndex } = entry;

    const head = el("div", "familyDetailHead");
    head.append(avatarImg(member, "familyDetailPhoto"));
    const heading = el("h3", "familyDetailName", member.is_self ? "You" : member.name);
    head.append(heading, el("p", "familyDetailRelation", relationshipPhrase(member, rowIndex)), statusBadge(member));
    panel.append(head, el("hr", "familyDetailRule"));

    if (member.is_self) {
        panel.append(
            el("p", "familyDetailText", "This is you. Your picture comes from your profile."),
            infoNote("Add the people around you with the + Member buttons, or invite them to ReelLife.")
        );
    } else if (member.status === "joined") {
        const username = member.linked_user?.username;
        panel.append(
            el(
                "p",
                "familyDetailText",
                `${member.name} is on ReelLife${username ? ` as @${username}` : ""}. You're friends and family, so ` +
                    "the stories they share with friends or family show up on your Friends page."
            )
        );
    } else {
        panel.append(detailInviteSection(member));
    }

    const actions = el("div", "familyDetailActions");
    actions.append(
        panelButton("familyLinkButton", "create-outline", "Edit details", () =>
            openFamilyModal("edit", { memberId: member.member_id })
        )
    );
    if (!member.is_self) {
        actions.append(
            panelButton("familyLinkButton danger", "trash-outline", "Remove from tree", () => {
                if (!confirmMemberRemoval(member)) return;
                removeFamilyMember(rowIndex, memberIndex);
            })
        );
    }
    panel.append(actions);
}

// ---- Members list (the "Members · N" drop-down) ----

function renderFamilyMemberList() {
    const entries = allFamilyMembers();
    familyEls.memberCount.textContent = String(entries.length);
    familyEls.memberList.innerHTML = "";
    entries.forEach(({ member, rowIndex }) => {
        const item = el("li");
        const row = el("button", "familyListRow");
        row.type = "button";
        const text = el("span", "familyListText");
        text.append(
            el("span", "familyListName", displayName(member)),
            el("span", "familyListRelation", member.relationship || generationLabel(rowIndex))
        );
        row.append(avatarImg(member, "familyListPhoto"), text, statusBadge(member));
        row.addEventListener("click", () => {
            selectFamilyMember(member.member_id);
            // Scrolls the tree sideways (and the page down) to their card.
            familyEls.tree
                .querySelector(`.familyCard[data-member-id="${member.member_id}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        });
        item.append(row);
        familyEls.memberList.append(item);
    });
    if (entries.length === 0) familyEls.memberList.append(el("li", "familyListEmpty", "No one in your tree yet."));
}

function renderFamilyPage() {
    if (!familyEls.tree) return;
    renderFamilyTreeBands();
    renderFamilyDetail();
    renderFamilyMemberList();
}

function selectFamilyMember(memberId) {
    selectedMemberId = memberId;
    if (detailMessage?.memberId !== memberId) detailMessage = null;
    renderFamilyPage();
}

// ---- Invitations (sending) ----

// Creates (or fetches) the member's invitation and keeps the tree in step
// with what the server now says about them. Returns the link.
async function createInvitation(member, email) {
    const result = await storageApi.inviteFamilyMember(member.member_id, email === undefined ? {} : { email });
    const entry = findFamilyMember(member.member_id);
    // The invite reply doesn't carry the tree's parent links; keep the ones
    // the member has.
    if (entry) Object.assign(entry.member, normalizeMember(result.member), { parents: entry.member.parents });
    lastSavedTree = normalizeFamilyTree(familyTree);
    return inviteLinkFor(result.token);
}

function setInlineError(errorEl, message) {
    errorEl.textContent = message || "";
    errorEl.classList.toggle("hidden", !message);
}

// There's no mail server behind ReelLife, so "Send" opens the user's own
// email app with the invitation written out, addressed to the member.
function openInviteEmail(member, email, link) {
    const subject = "Join our family tree on ReelLife";
    const body =
        `Hi ${member.name.split(" ")[0]},\n\n` +
        "I've added you to our family tree on ReelLife, where we're saving our family's stories. " +
        `Open this link to join and take your place in the tree:\n\n${link}\n`;
    const mail = document.createElement("a");
    mail.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    mail.click();
}

async function sendInvitation(member, email, errorEl) {
    if (!isEmailAddress(email)) {
        setInlineError(errorEl, "Enter their email address first.");
        return;
    }
    if (member.member_id === null || familySaveInFlight) return;
    setInlineError(errorEl, "");
    try {
        const link = await createInvitation(member, email);
        openInviteEmail(member, email, link);
        detailMessage = {
            memberId: member.member_id,
            text: "Your email app should open with the invitation ready to send.",
        };
        renderFamilyPage();
    } catch (err) {
        if (err?.status === 401) return handleFamilyError(err);
        setInlineError(errorEl, `Couldn't create the invitation: ${familyErrorText(err)}.`);
    }
}

async function copyInviteLink(member, errorEl) {
    if (member.member_id === null || familySaveInFlight) return;
    setInlineError(errorEl, "");
    let link;
    try {
        link = await createInvitation(member);
    } catch (err) {
        if (err?.status === 401) return handleFamilyError(err);
        setInlineError(errorEl, `Couldn't create the invitation: ${familyErrorText(err)}.`);
        return;
    }
    try {
        await navigator.clipboard.writeText(link);
        detailMessage = { memberId: member.member_id, text: "Invite link copied." };
    } catch (err) {
        // No clipboard access (an http:// page, or permission refused).
        prompt("Copy this invite link:", link);
        detailMessage = null;
    }
    renderFamilyPage();
}

// ---- The add / edit dialog ----
//
// One form for every way someone gets into the tree:
//   "friend"  Add member  -- someone already on ReelLife: pick a friend
//   "new"     + Member / Invite family -- someone not on ReelLife: a name,
//             and an email to invite them (required for Invite family)
//   "edit"    Edit details -- anyone already in the tree

let familyModal = null; // { mode, memberId, requireEmail, derivedRelationship }
let familyFriends = [];

// ---- "Related to ... as their ..." ----
//
// Adding someone next to a person already in the tree: picking who and how
// puts them in the right generation and words "Relationship to you" for them
// (a sister of Mom is your aunt). Only the result is saved -- the tree stores
// generations, not who is whose parent.

// The "As their" choices, grouped as they appear in the list.
const FAMILY_RELATION_CHOICES = [
    { label: "Parent", values: ["mother", "father", "parent"] },
    { label: "Child", values: ["daughter", "son", "child"] },
    { label: "Sibling", values: ["sister", "brother", "sibling"] },
    { label: "Partner", values: ["wife", "husband", "partner"] },
];

// The words for each kind of relative: [female, male, either].
const RELATION_WORDS = {
    parent: ["Mother", "Father", "Parent"],
    child: ["Daughter", "Son", "Child"],
    sibling: ["Sister", "Brother", "Sibling"],
    spouse: ["Wife", "Husband", "Partner"],
    auncle: ["Aunt", "Uncle", "Aunt or uncle"],
    nibling: ["Niece", "Nephew", "Niece or nephew"],
    cousin: ["Cousin", "Cousin", "Cousin"],
    grandparent: ["Grandmother", "Grandfather", "Grandparent"],
    grandchild: ["Granddaughter", "Grandson", "Grandchild"],
    greatGrandparent: ["Great-grandmother", "Great-grandfather", "Great-grandparent"],
    greatGrandchild: ["Great-granddaughter", "Great-grandson", "Great-grandchild"],
    greatAuncle: ["Great-aunt", "Great-uncle", "Great-aunt or uncle"],
    parentInLaw: ["Mother-in-law", "Father-in-law", "Parent-in-law"],
    siblingInLaw: ["Sister-in-law", "Brother-in-law", "Sibling-in-law"],
    childInLaw: ["Daughter-in-law", "Son-in-law", "Child-in-law"],
};

// Every word above (plus a few everyday ones), read back as { kind, gender }
// so a typed-in relationship like "Mom" or "uncle" is understood too.
const RELATION_ROLES = (() => {
    const roles = {};
    for (const [kind, words] of Object.entries(RELATION_WORDS)) {
        words.forEach((word, gender) => {
            const key = word.toLowerCase();
            if (!roles[key]) roles[key] = { kind, gender };
        });
    }
    Object.assign(roles, {
        mom: { kind: "parent", gender: 0 },
        mum: { kind: "parent", gender: 0 },
        dad: { kind: "parent", gender: 1 },
        spouse: { kind: "spouse", gender: 2 },
        grandma: { kind: "grandparent", gender: 0 },
        grandpa: { kind: "grandparent", gender: 1 },
    });
    return roles;
})();

// How many generations down (+) or up (-) each "As their" kind is.
const RELATION_OFFSETS = { parent: -1, child: 1, sibling: 0, spouse: 0 };

// "<their relationship to you>+<new person's to them>" -> the new person's
// to you. Pairs not listed are worded as "Mom's mother" instead.
const RELATION_CHAINS = {
    "parent+sibling": "auncle",
    "parent+child": "sibling",
    "parent+parent": "grandparent",
    "sibling+sibling": "sibling",
    "sibling+parent": "parent",
    "sibling+child": "nibling",
    "sibling+spouse": "siblingInLaw",
    "child+child": "grandchild",
    "child+sibling": "child",
    "child+spouse": "childInLaw",
    "spouse+parent": "parentInLaw",
    "spouse+sibling": "siblingInLaw",
    "spouse+child": "child",
    "auncle+child": "cousin",
    "auncle+spouse": "auncle",
    "auncle+sibling": "auncle",
    "nibling+sibling": "nibling",
    "cousin+sibling": "cousin",
    "grandparent+parent": "greatGrandparent",
    "grandparent+sibling": "greatAuncle",
    "grandparent+spouse": "grandparent",
    "grandchild+sibling": "grandchild",
    "grandchild+child": "greatGrandchild",
};

// Matches MAX_RELATIONSHIP_LENGTH in ../family.js (and the input's maxlength).
const FAMILY_RELATIONSHIP_MAX = 50;

// A relationship as { kind, gender }: "Aunt", "mom", or the starting tree's
// "Mom's mother" (a grandparent) and "Dad's sister" (an aunt).
const PARENT_SIDE_CHAINS = { parent: "grandparent", sibling: "auncle" };
function relationRole(relationship) {
    const text = String(relationship || "").trim().toLowerCase();
    if (RELATION_ROLES[text]) return RELATION_ROLES[text];
    const side = text.match(/^(?:mom|mum|dad|mother|father)['’]s\s+(.+)$/);
    const inner = side && RELATION_ROLES[side[1]];
    const kind = inner && PARENT_SIDE_CHAINS[inner.kind];
    return kind ? { kind, gender: inner.gender } : null;
}

// "Mother" -> "Mom's", for the "Mom's mother" wording the starting tree uses.
function relationPossessive(member) {
    const role = relationRole(member.relationship);
    if (role?.kind === "parent" && role.gender < 2) return role.gender === 0 ? "Mom's" : "Dad's";
    return `${member.relationship || member.name}'s`;
}

// What someone who is `choice` ("sister") to `anchor` is to you.
function derivedRelationship(anchor, choice) {
    const role = RELATION_ROLES[choice];
    if (!anchor || !role) return "";
    if (anchor.is_self) return RELATION_WORDS[role.kind][role.gender];
    const anchorRole = relationRole(anchor.relationship);
    const chained = anchorRole && RELATION_CHAINS[`${anchorRole.kind}+${role.kind}`];
    if (chained) return RELATION_WORDS[chained][role.gender];
    const word = RELATION_WORDS[role.kind][role.gender].toLowerCase();
    const phrase = `${relationPossessive(anchor)} ${word}`;
    if (phrase.length <= FAMILY_RELATIONSHIP_MAX) return phrase;
    return `${anchor.name}'s ${word}`.slice(0, FAMILY_RELATIONSHIP_MAX);
}

// Which generation that puts them in. -1 or rows.length is a new generation
// above or below the tree, which addFamilyMember creates.
function derivedGeneration(anchorEntry, choice) {
    const role = RELATION_ROLES[choice];
    if (!anchorEntry || !role) return null;
    const row = anchorEntry.rowIndex + RELATION_OFFSETS[role.kind];
    return Math.max(-1, Math.min(row, familyTree.rows.length));
}

// `relatedToId` defaults to the selected person (or you).
function fillRelatedSelects(relatedToId, relatedAs) {
    familyEls.relatedTo.innerHTML = "";
    allFamilyMembers().forEach(({ member, rowIndex }) => {
        if (member.member_id === null) return;
        const detail = member.is_self ? "" : ` (${member.relationship || generationLabel(rowIndex)})`;
        const option = el("option", "", `${displayName(member)}${detail}`);
        option.value = String(member.member_id);
        familyEls.relatedTo.append(option);
    });
    const start = findFamilyMember(relatedToId) || selectedFamilyEntry();
    if (start) familyEls.relatedTo.value = String(start.member.member_id);

    familyEls.relatedAs.innerHTML = "";
    const none = el("option", "", "Choose…");
    none.value = "";
    familyEls.relatedAs.append(none);
    FAMILY_RELATION_CHOICES.forEach(({ label, values }) => {
        const group = document.createElement("optgroup");
        group.label = label;
        values.forEach((value) => {
            const { kind, gender } = RELATION_ROLES[value];
            const option = el("option", "", RELATION_WORDS[kind][gender]);
            option.value = value;
            group.append(option);
        });
        familyEls.relatedAs.append(group);
    });
    familyEls.relatedAs.value = RELATION_ROLES[relatedAs] ? relatedAs : "";
}

// Puts the "Related to / As their" choice into Generation and "Relationship
// to you" -- the latter only while it's empty or still what this filled in,
// so something typed there isn't overwritten.
function applyRelatedChoice() {
    if (!familyModal) return;
    const anchor = findFamilyMember(Number(familyEls.relatedTo.value));
    const choice = familyEls.relatedAs.value;
    const row = derivedGeneration(anchor, choice);
    if (row === null) return;
    familyEls.generation.value = String(row);

    const typed = familyEls.relationship.value.trim();
    if (typed === "" || typed === familyModal.derivedRelationship) {
        const relationship = derivedRelationship(anchor.member, choice);
        familyEls.relationship.value = relationship;
        familyModal.derivedRelationship = relationship;
    }
}

function newGenerationLabel(rowIndex, where) {
    if (selfRowIndex() < 0) return `New generation (${where})`;
    return `${generationLabel(rowIndex)} (new)`;
}

// Lists the generations, plus a new one above and below the tree when
// adding (`allowNew`) -- so a parent of the top row has somewhere to go.
function fillGenerationSelect(selectedRow, { allowNew = false } = {}) {
    familyEls.generation.innerHTML = "";
    const addOption = (rowIndex, label) => {
        const option = el("option", "", label);
        option.value = String(rowIndex);
        familyEls.generation.append(option);
    };
    const count = familyTree.rows.length;
    if (allowNew) addOption(-1, newGenerationLabel(-1, "top"));
    familyTree.rows.forEach((_, rowIndex) => addOption(rowIndex, generationLabel(rowIndex)));
    if (allowNew) addOption(count, newGenerationLabel(count, "bottom"));
    const lowest = allowNew ? -1 : 0;
    const highest = allowNew ? count : count - 1;
    familyEls.generation.value = String(Math.max(lowest, Math.min(selectedRow, highest)));
}

// Friends who aren't in the tree yet. Switching modes quickly can start a
// second load before the first answers; only the latest one fills the list.
let familyFriendLoad = 0;
async function loadFamilyFriendOptions() {
    const load = ++familyFriendLoad;
    familyEls.friendSelect.innerHTML = "";
    familyEls.friendSelect.disabled = true;
    familyEls.friendEmpty.classList.add("hidden");
    try {
        familyFriends = await storageApi.listFriends();
    } catch (err) {
        familyFriends = [];
    }
    if (load !== familyFriendLoad || familyModal?.mode !== "friend") return;
    const inTree = new Set(allFamilyMembers().map(({ member }) => member.linked_user?.id).filter(Boolean));
    const available = familyFriends.filter((friend) => !inTree.has(friend.id));
    available.forEach((friend) => {
        const option = el("option", "", friend.username);
        option.value = String(friend.id);
        familyEls.friendSelect.append(option);
    });
    familyEls.friendSelect.disabled = available.length === 0;
    familyEls.friendEmpty.classList.toggle("hidden", available.length > 0);
    familyEls.modalSubmit.disabled = available.length === 0;
    if (available.length) familyEls.name.value = available[0].username;
}

function setFamilyModalError(message) {
    familyEls.modalError.textContent = message || "";
    familyEls.modalError.classList.toggle("hidden", !message);
}

const FAMILY_MODAL_TEXT = {
    friend: {
        title: "Add a family member",
        intro: "Someone who's already on ReelLife. Pick them from your friends.",
        submit: "Add to tree",
        switchText: "Not on ReelLife yet? Invite them instead",
    },
    new: {
        title: "Add a family member",
        intro: "Add them to your tree. Give an email address to invite them to ReelLife too.",
        submit: "Add to tree",
        switchText: "Already on ReelLife? Pick from your friends",
    },
    invite: {
        title: "Invite family",
        intro: "Add someone who's new to ReelLife, and invite them by email.",
        submit: "Add and invite",
        switchText: "Already on ReelLife? Pick from your friends",
    },
    edit: { title: "Edit details", intro: "", submit: "Save", switchText: "" },
};

// `options`: rowIndex (where to add), memberId (who to edit), requireEmail.
function openFamilyModal(mode, options = {}) {
    if (!familyLoaded || familySaveInFlight) return;
    if (!FAMILY_MODAL_TEXT[mode]) {
        console.error(`openFamilyModal: unknown mode "${mode}"`);
        return;
    }
    if (familyTree.rows.length === 0 && mode !== "edit") {
        alert("Add a generation to your tree first.");
        return;
    }
    const editing = mode === "edit" ? findFamilyMember(options.memberId) : null;
    if (mode === "edit" && !editing) return;
    const textKey = mode === "new" && options.requireEmail ? "invite" : mode;
    familyModal = {
        mode,
        memberId: editing?.member.member_id ?? null,
        requireEmail: Boolean(options.requireEmail),
        derivedRelationship: null,
    };

    const text = FAMILY_MODAL_TEXT[textKey];
    familyEls.modalTitle.textContent = editing ? `Edit ${displayName(editing.member)}` : text.title;
    familyEls.modalIntro.textContent = text.intro;
    familyEls.modalIntro.classList.toggle("hidden", !text.intro);
    familyEls.modalSubmit.textContent = text.submit;
    // Picking a friend waits for the list (loadFamilyFriendOptions turns it on).
    familyEls.modalSubmit.disabled = mode === "friend";
    familyEls.modeSwitch.textContent = text.switchText;
    familyEls.modeSwitch.classList.toggle("hidden", !text.switchText);

    const row = options.rowIndex ?? editing?.rowIndex ?? Math.max(0, selfRowIndex());
    fillGenerationSelect(row, { allowNew: !editing });
    familyEls.name.value = editing?.member.name ?? options.name ?? "";
    familyEls.relationship.value = editing?.member.relationship ?? options.relationship ?? "";
    familyEls.email.value = editing?.member.email ?? options.email ?? "";
    familyEls.email.required = familyModal.requireEmail;

    // "Related to" is for adding; it starts on whoever is selected.
    familyEls.relatedField.classList.toggle("hidden", Boolean(editing) || allFamilyMembers().length === 0);
    if (!editing) {
        fillRelatedSelects(options.relatedToId, options.relatedAs);
        // A + Member button already chose the generation; anything else
        // (or a choice carried over by the mode switch) goes by the relation.
        if (options.relatedAs) {
            familyModal.derivedRelationship = options.derivedRelationship ?? null;
            applyRelatedChoice();
        }
    }

    const member = editing?.member;
    familyEls.friendField.classList.toggle("hidden", mode !== "friend");
    familyEls.emailField.classList.toggle("hidden", mode === "friend" || member?.is_self || member?.status === "joined");
    familyEls.emailField.querySelector("span").textContent = familyModal.requireEmail
        ? "Email address"
        : "Email address (optional)";
    setFamilyModalError("");
    familyEls.modal.classList.remove("hidden");
    if (mode === "friend") loadFamilyFriendOptions();
    (mode === "friend" ? familyEls.friendSelect : familyEls.name).focus();
}

function closeFamilyModal() {
    familyModal = null;
    familyEls.modal.classList.add("hidden");
}

async function submitFamilyModal() {
    if (!familyModal || familySaveInFlight) return;
    const { mode, memberId, requireEmail } = familyModal;
    const name = familyEls.name.value.trim();
    const relationship = familyEls.relationship.value.trim();
    const email = familyEls.email.value.trim();
    const rowIndex = Number(familyEls.generation.value);

    if (!name) return setFamilyModalError("Please give their name.");
    if (mode !== "friend" && (email || requireEmail) && !isEmailAddress(email)) {
        return setFamilyModalError("Please enter a valid email address.");
    }

    if (mode === "edit") {
        const entry = findFamilyMember(memberId);
        if (!entry) return closeFamilyModal();
        const showsEmail = !familyEls.emailField.classList.contains("hidden");
        closeFamilyModal();
        await editFamilyTree("save those details", () => {
            Object.assign(entry.member, { name, relationship, ...(showsEmail ? { email } : {}) });
            // Moving to another generation goes to the end of that row.
            if (rowIndex !== entry.rowIndex && familyTree.rows[rowIndex]) {
                familyTree.rows[entry.rowIndex].members.splice(entry.memberIndex, 1);
                familyTree.rows[rowIndex].members.push(entry.member);
            }
        });
        return;
    }

    let linkedUser = null;
    if (mode === "friend") {
        const friendId = Number(familyEls.friendSelect.value);
        const friend = familyFriends.find((candidate) => candidate.id === friendId);
        if (!friend) return setFamilyModalError("Pick one of your friends.");
        linkedUser = { id: friend.id, username: friend.username };
    }

    closeFamilyModal();
    // Who they were added next to, and how, places their lines in the tree.
    const relatedAs = RELATION_ROLES[familyEls.relatedAs.value];
    const anchorId = Number(familyEls.relatedTo.value);
    const relation =
        relatedAs && !familyEls.relatedField.classList.contains("hidden") && findFamilyMember(anchorId)
            ? { anchorId, kind: relatedAs.kind }
            : null;
    const added = await addFamilyMember(
        rowIndex,
        {
            name,
            relationship,
            email: mode === "friend" ? "" : email,
            linked_user: linkedUser,
            status: linkedUser ? "joined" : "not_invited",
        },
        relation
    );
    if (!added || mode === "friend" || !email) return;

    // Added someone new with an email: write the invitation straight away.
    try {
        const link = await createInvitation(added, email);
        openInviteEmail(added, email, link);
        detailMessage = { memberId: added.member_id, text: "Your email app should open with the invitation ready to send." };
    } catch (err) {
        detailMessage = { memberId: added.member_id, text: `They're in your tree, but the invitation failed: ${familyErrorText(err)}.` };
    }
    renderFamilyPage();
}

// ---- Invitations (receiving) ----

// Takes the token out of the address bar (so a refresh doesn't ask again),
// or from where authGuard.js kept it while the visitor signed in.
function takePendingInvite() {
    const url = new URL(window.location.href);
    let token = url.searchParams.get(FAMILY_INVITE_PARAM);
    if (token) {
        url.searchParams.delete(FAMILY_INVITE_PARAM);
        history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    try {
        token = token || sessionStorage.getItem(PENDING_INVITE_KEY);
        sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch (err) {
        // Storage blocked: only the address bar counts.
    }
    return token || null;
}

let pendingInviteToken = null;

async function offerPendingInvite() {
    const token = takePendingInvite();
    if (!token) return;
    let invite;
    try {
        invite = await storageApi.getFamilyInvite(token);
    } catch (err) {
        if (err?.status === 401) return;
        alert(`That invitation can't be used: ${familyErrorText(err)}.`);
        return;
    }
    if (invite.own) {
        alert("That's an invitation you made. Send the link to the person you added, and they can join from it.");
        return;
    }
    pendingInviteToken = token;
    const role = invite.member.relationship ? ` as ${invite.member.relationship.toLowerCase()}` : "";
    familyEls.inviteText.textContent =
        `${invite.from.name} added you to their family tree${role} ("${invite.member.name}"). ` +
        `Join to take that place in their tree. You and ${invite.from.name} will become friends, so you can read ` +
        "each other's stories.";
    familyEls.inviteModal.classList.remove("hidden");
    familyEls.inviteAccept.focus();
}

function closeInviteModal() {
    pendingInviteToken = null;
    familyEls.inviteModal.classList.add("hidden");
}

async function acceptPendingInvite() {
    const token = pendingInviteToken;
    if (!token) return;
    familyEls.inviteAccept.disabled = true;
    try {
        const result = await storageApi.acceptFamilyInvite(token);
        closeInviteModal();
        alert(`You've joined ${result.from.name}'s family tree, and you're now friends.`);
        // friends.js loads after this file and owns the Friends page.
        if (typeof refreshFriendsUi === "function") refreshFriendsUi();
    } catch (err) {
        closeInviteModal();
        handleFamilyError(err, "accept the invitation");
    } finally {
        familyEls.inviteAccept.disabled = false;
    }
}

// ---- Wiring ----

function wireFamilyPage() {
    familyEls.addMember.addEventListener("click", () => openFamilyModal("friend"));
    familyEls.invite.addEventListener("click", () => openFamilyModal("new", { requireEmail: true }));
    familyEls.modeSwitch.addEventListener("click", () => {
        // Keep what's been chosen so far. The name stays behind: in friend
        // mode it's the friend's username.
        openFamilyModal(familyModal?.mode === "friend" ? "new" : "friend", {
            rowIndex: Number(familyEls.generation.value),
            relationship: familyEls.relationship.value,
            relatedToId: Number(familyEls.relatedTo.value),
            relatedAs: familyEls.relatedAs.value,
            derivedRelationship: familyModal?.derivedRelationship,
        });
    });
    familyEls.relatedTo.addEventListener("change", applyRelatedChoice);
    familyEls.relatedAs.addEventListener("change", applyRelatedChoice);
    familyEls.friendSelect.addEventListener("change", () => {
        const friend = familyFriends.find((candidate) => String(candidate.id) === familyEls.friendSelect.value);
        if (friend) familyEls.name.value = friend.username;
    });
    familyEls.form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitFamilyModal();
    });
    familyEls.modalCancel.addEventListener("click", closeFamilyModal);
    familyEls.modal.addEventListener("click", (event) => {
        if (event.target === familyEls.modal) closeFamilyModal();
    });
    familyEls.inviteAccept.addEventListener("click", acceptPendingInvite);
    familyEls.inviteDismiss.addEventListener("click", closeInviteModal);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!familyEls.modal.classList.contains("hidden")) closeFamilyModal();
        if (!familyEls.inviteModal.classList.contains("hidden")) closeInviteModal();
    });
    familyEls.reset?.addEventListener("click", () => {
        // The only action that throws away a whole tree at once, so it asks.
        if (!confirm("Replace your family tree with the starting one? Everyone in it now will be removed.")) return;
        resetFamilyTree();
    });
    // The lines are measured from the cards, which have no size while the
    // page is hidden -- so draw them again whenever it's opened. Reloading
    // then also picks up an invitation someone accepted, or a new profile
    // photo, since the page was loaded.
    $("#family").click(() => {
        setTimeout(layoutFamilyTree, 0);
        if (familyLoaded && !familySaveInFlight && familyEls.modal.classList.contains("hidden")) {
            refreshFamilyTree().catch(() => {
                // Keep showing what's there; the next edit will report a problem.
            });
        }
    });
}

async function initFamilyTree() {
    if (!familyEls.tree || !storageApi.isLoggedIn()) return;
    renderFamilyPage();
    wireFamilyPage();
    offerPendingInvite();

    try {
        await refreshFamilyTree();
    } catch (err) {
        handleFamilyError(err, "load your family tree");
    }
}

initFamilyTree();

// Grouped for anything else that wants to read or change the tree (the story
// tabs later on, or the console while debugging).
const familyStore = {
    get: getFamilyTree,
    refresh: refreshFamilyTree,
    render: renderFamilyPage,
    addMember: addFamilyMember,
    updateMember: updateFamilyMember,
    removeMember: removeFamilyMember,
    insertRow: insertFamilyRow,
    removeRowAt: removeFamilyRowAt,
    addRow: addFamilyRow,
    removeRow: removeFamilyRow,
    reset: resetFamilyTree,
};
