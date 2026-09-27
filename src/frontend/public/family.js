// "Family" tab.
//
// The tree in index.html is rendered from -- and saved back to -- the logged-in
// user's tree on the server (GET/PUT /family, see ../family.js), so it follows
// the account rather than the browser: two people on the same device never see
// each other's family.
//
// The model mirrors the API payload exactly, so nothing has to be translated
// between the two:
//   { rows: [ { members: [ { name, photo, is_self } ] } ] }
// Row 1 is the top of the tree (grandparents), each later row a generation
// below it, matching the .familyTreeRow order in the markup. is_self marks the
// account holder's own node, which can't be removed individually.
//
// The markup in index.html is a placeholder shown until the fetch lands, and
// doubles as the starting layout for an account that has never saved a tree.

const DEFAULT_MEMBER_PHOTO = "profile.jpg";
const DEFAULT_MEMBER_NAME = "Unnamed";

const familyTreeEl = document.querySelector(".familyTree");
const resetFamilyTreeBtn = document.querySelector("#resetTree");

// What's on screen. Edits land here first and are saved immediately after.
let familyTree = { rows: [] };

// The last tree the server confirmed. An edit is drawn before it's saved, so
// this is what the page falls back to when a save can't be completed.
let lastSavedTree = { rows: [] };

// ---- Model ----

// Copies a tree and drops anything unexpected, so a surprising payload (or a
// caller's object) can't break rendering or be mutated by accident.
function normalizeFamilyTree(raw) {
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];
    return {
        rows: rows.map((row) => ({
            members: (Array.isArray(row?.members) ? row.members : []).map((member) => ({
                name: String(member?.name ?? "").trim() || DEFAULT_MEMBER_NAME,
                photo: String(member?.photo ?? "").trim() || DEFAULT_MEMBER_PHOTO,
                is_self: Boolean(member?.is_self),
            })),
        })),
    };
}

// Reads the family members sitting in the markup.
function readFamilyTreeFromDom() {
    const rowEls = familyTreeEl ? familyTreeEl.querySelectorAll(".familyTreeRow") : [];
    return {
        rows: [...rowEls].map((rowEl) => ({
            members: [...rowEl.children].map((memberEl) => {
                const heading = memberEl.querySelector("h3");
                const img = memberEl.querySelector("img");
                return {
                    // The name is the text before the <img>, e.g. "Grandma (moms side)".
                    name: heading?.firstChild?.textContent.trim() || DEFAULT_MEMBER_NAME,
                    photo: img?.getAttribute("src") || DEFAULT_MEMBER_PHOTO,
                    // data-self marks the account holder's own node in the markup.
                    is_self: memberEl.hasAttribute("data-self"),
                };
            }),
        })),
    };
}

// Captured now, at load, because the first render replaces the markup it reads
// -- taken any later this would just return whatever is currently on screen,
// and "reset" would reset to nothing.
const MARKUP_TREE = readFamilyTreeFromDom();

function startingTree() {
    return normalizeFamilyTree(MARKUP_TREE);
}

function getFamilyTree() {
    return familyTree;
}

// ---- Server ----

// Only an account that has never saved a tree gets the markup's layout as a
// starting point. A tree that was deliberately emptied comes back with
// `seeded` set, and is left empty.
async function loadFamilyTree() {
    const payload = await storageApi.getFamily();
    const stored = normalizeFamilyTree(payload);
    if (payload?.seeded || stored.rows.length > 0) return stored;

    return normalizeFamilyTree(await storageApi.saveFamily(startingTree()));
}

// The only place that writes. Returns the server's copy of the tree.
function saveFamilyTree() {
    return storageApi.saveFamily(familyTree);
}

// Pulls the server's copy in and draws it.
async function refreshFamilyTree() {
    familyTree = await loadFamilyTree();
    lastSavedTree = normalizeFamilyTree(familyTree);
    renderFamilyTree();
    return familyTree;
}

function handleFamilyError(err, action) {
    if (err?.status === 401) {
        window.location.href = "login.html";
        return;
    }

    // fetch() rejects with a TypeError when it never reached the server at all
    // -- "Failed to fetch" on its own doesn't say that, so spell it out.
    const reason =
        err instanceof TypeError
            ? "the server isn't responding. Check that it's still running, then try again"
            : err?.detail || err?.message || "unknown error";
    alert(`Could not ${action}: ${reason}.`);
}

// Draws the change straight away, then saves it. If the save fails the page is
// put back to what the server actually holds, so a change that wasn't saved
// never sits on screen looking like it was.
async function persistFamilyTree(action) {
    renderFamilyTree();
    try {
        familyTree = normalizeFamilyTree(await saveFamilyTree());
    } catch (err) {
        handleFamilyError(err, action);
        try {
            familyTree = normalizeFamilyTree(await storageApi.getFamily());
        } catch (refetchErr) {
            // Can't reach the server to ask, so undo the change instead.
            familyTree = normalizeFamilyTree(lastSavedTree);
        }
    }
    lastSavedTree = normalizeFamilyTree(familyTree);
    renderFamilyTree();
}

// ---- Members ----

async function addFamilyMember(rowIndex, name, photo = DEFAULT_MEMBER_PHOTO) {
    const row = familyTree.rows[rowIndex];
    if (!row) return null;

    const member = { name: String(name ?? "").trim() || DEFAULT_MEMBER_NAME, photo, is_self: false };
    row.members.push(member);
    await persistFamilyTree("add that family member");
    return member;
}

async function renameFamilyMember(rowIndex, memberIndex, name) {
    const member = familyTree.rows[rowIndex]?.members[memberIndex];
    if (!member) return null;

    const trimmed = String(name ?? "").trim() || DEFAULT_MEMBER_NAME;
    if (trimmed === member.name) return member;

    member.name = trimmed;
    await persistFamilyTree("save that name");
    return member;
}

// You can't remove yourself from your own family tree. The button isn't drawn
// for that member, and this guard covers anything calling it directly.
async function removeFamilyMember(rowIndex, memberIndex) {
    const row = familyTree.rows[rowIndex];
    const member = row?.members[memberIndex];
    if (!member || member.is_self) return null;

    const [removed] = row.members.splice(memberIndex, 1);
    await persistFamilyTree("remove that family member");
    return removed;
}

// ---- Rows ----

// Inserts a row at `index`, pushing the rows below it down. Index 0 puts it at
// the top of the tree, familyTree.rows.length appends it at the bottom.
async function insertFamilyRow(index, members = [{ name: DEFAULT_MEMBER_NAME, photo: DEFAULT_MEMBER_PHOTO }]) {
    const position = Math.max(0, Math.min(index, familyTree.rows.length));
    const row = normalizeFamilyTree({ rows: [{ members }] }).rows[0];
    familyTree.rows.splice(position, 0, row);
    await persistFamilyTree("add that row");
    return row;
}

async function removeFamilyRowAt(index) {
    const row = familyTree.rows[index];
    if (!row) return null;

    const [removed] = familyTree.rows.splice(index, 1);
    await persistFamilyTree("remove that row");
    return removed;
}

// Appends at the bottom / removes the bottom row. The buttons work a row at a
// time; these are the whole-tree shortcuts familyStore exposes.
function addFamilyRow(members) {
    return insertFamilyRow(familyTree.rows.length, members);
}

function removeFamilyRow() {
    return removeFamilyRowAt(familyTree.rows.length - 1);
}

// Throws away the saved tree and goes back to the markup's starting layout.
async function resetFamilyTree() {
    familyTree = startingTree();
    await persistFamilyTree("reset the family tree");
    return familyTree;
}

// ---- Rendering ----

function createControlButton(className, label, description, onClick) {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.textContent = label;
    button.title = description;
    button.setAttribute("aria-label", description);
    button.addEventListener("click", onClick);
    return button;
}

// One family member: an editable name, a photo, and -- unless this is you -- a
// button to remove them. The name saves on blur or Enter.
function createFamilyMemberEl(rowIndex, memberIndex, member) {
    const cell = document.createElement("div");
    cell.className = `familyMember r${rowIndex + 1} c${memberIndex + 1}`;
    if (member.is_self) {
        cell.classList.add("isSelf");
        cell.dataset.self = "";
    }

    const heading = document.createElement("h3");

    const nameField = document.createElement("span");
    nameField.className = "familyMemberName";
    nameField.contentEditable = "true";
    nameField.spellcheck = false;
    nameField.setAttribute("role", "textbox");
    nameField.setAttribute("aria-label", `Name of family member ${memberIndex + 1}, row ${rowIndex + 1}`);
    nameField.textContent = member.name;
    nameField.addEventListener("blur", () => {
        renameFamilyMember(rowIndex, memberIndex, nameField.textContent);
    });
    nameField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            nameField.blur();
        }
    });

    const photo = document.createElement("img");
    photo.src = member.photo || DEFAULT_MEMBER_PHOTO;
    photo.alt = "profile";

    heading.append(nameField, photo);
    cell.append(heading);

    if (!member.is_self) {
        cell.append(
            createControlButton("familyMemberRemove", "×", `Remove ${member.name}`, () => {
                if (!confirm(`Remove ${member.name} from your family tree?`)) return;
                removeFamilyMember(rowIndex, memberIndex);
            })
        );
    }

    return cell;
}

// Asks before dropping a whole row of people. An empty row goes without a
// question; a row holding you says so explicitly.
function confirmRowRemoval(row, rowIndex) {
    if (row.members.some((member) => member.is_self)) {
        return confirm(`Row ${rowIndex + 1} includes you. Remove it anyway?`);
    }
    if (row.members.length > 0) {
        const count = row.members.length;
        return confirm(`Remove row ${rowIndex + 1} and the ${count} ${count === 1 ? "person" : "people"} in it?`);
    }
    return true;
}

// The controls beside each row: add a member to it, add a new row above or
// below it, or remove the row itself.
function createRowControls(rowIndex, row) {
    const controls = document.createElement("div");
    controls.className = `familyRowControls CR${rowIndex + 1}`;
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `Row ${rowIndex + 1} controls`);

    controls.append(
        createControlButton(
            `familyTreeRowAddBtn AR${rowIndex + 1}`,
            "Add",
            `Add a family member to row ${rowIndex + 1}`,
            () => {
                const name = prompt("Who would you like to add to this row?");
                if (name === null) return;
                addFamilyMember(rowIndex, name);
            }
        ),
        createControlButton("familyRowAddAbove", "↑+", `Add a new row above row ${rowIndex + 1}`, () =>
            insertFamilyRow(rowIndex)
        ),
        createControlButton("familyRowAddBelow", "↓+", `Add a new row below row ${rowIndex + 1}`, () =>
            insertFamilyRow(rowIndex + 1)
        ),
        createControlButton("familyRowRemove", "×", `Remove row ${rowIndex + 1}`, () => {
            if (!confirmRowRemoval(row, rowIndex)) return;
            removeFamilyRowAt(rowIndex);
        })
    );

    return controls;
}

// An empty tree has no rows to hang controls off, so it carries its own button
// to start the first one.
function renderEmptyFamilyTree() {
    const message = document.createElement("p");
    message.className = "familyTreeEmpty";
    message.textContent = "Your family tree is empty.";

    const addFirstRow = createControlButton("familyTreeEmptyAdd", "Add a row", "Add the first row", () =>
        insertFamilyRow(0)
    );

    familyTreeEl.append(message, addFirstRow);
}

// Rebuilds the whole tree from the model. Cheap at this size, and it keeps the
// row/column classes and the row-then-controls ordering the CSS relies on.
function renderFamilyTree() {
    if (!familyTreeEl) return;

    familyTreeEl.innerHTML = "";
    if (familyTree.rows.length === 0) {
        renderEmptyFamilyTree();
        return;
    }

    familyTree.rows.forEach((row, rowIndex) => {
        const rowEl = document.createElement("div");
        rowEl.className = `familyTreeRow R${rowIndex + 1}`;
        row.members.forEach((member, memberIndex) => {
            rowEl.append(createFamilyMemberEl(rowIndex, memberIndex, member));
        });
        familyTreeEl.append(rowEl, createRowControls(rowIndex, row));
    });
}

// ---- Wiring ----

// Until this resolves the page shows the static markup from index.html, which
// is the same layout a new account starts with.
async function initFamilyTree() {
    if (!familyTreeEl || !storageApi.isLoggedIn()) return;

    try {
        await refreshFamilyTree();
    } catch (err) {
        handleFamilyError(err, "load your family tree");
        return;
    }

    // Wired only once the tree has loaded, so an early click can't save over it.
    // The row buttons are wired as they render.
    resetFamilyTreeBtn?.addEventListener("click", () => {
        // The only action that throws away a whole tree at once, so it asks.
        if (!confirm("Replace your family tree with the default one? Everything in it now will be lost.")) return;
        resetFamilyTree();
    });
}

initFamilyTree();

// Grouped for anything else that wants to read or change the tree (the story
// tabs later on, or the console while debugging).
const familyStore = {
    get: getFamilyTree,
    refresh: refreshFamilyTree,
    save: saveFamilyTree,
    render: renderFamilyTree,
    addMember: addFamilyMember,
    renameMember: renameFamilyMember,
    removeMember: removeFamilyMember,
    insertRow: insertFamilyRow,
    removeRowAt: removeFamilyRowAt,
    addRow: addFamilyRow,
    removeRow: removeFamilyRow,
    reset: resetFamilyTree,
};
