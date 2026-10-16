// Tests for /family (family.js). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(os.tmpdir(), `test-family-${process.pid}.db`);
process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-family-media-"));

const app = require("../app");
const { db } = require("../db");

let server;
let baseUrl;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close(); // Windows won't delete a file that's still open
    fs.rmSync(process.env.DATABASE_PATH, { force: true });
    fs.rmSync(process.env.MEDIA_ROOT, { recursive: true, force: true });
});

async function request(method, urlPath, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
}

async function signupAndLogin(username, email, password = "password123") {
    await request("POST", "/signup", { body: { username, email, password } });
    return (await request("POST", "/login", { body: { email, password } })).body.token;
}

function tree(...rows) {
    return {
        rows: rows.map((names) => ({
            members: names.map((name) => ({ name, photo: "profile.jpg", is_self: false })),
        })),
    };
}

// What a GET/PUT returns for a tree that has been saved at least once.
function saved(...rows) {
    return { ...tree(...rows), seeded: true };
}

// A response cut down to the fields tree() builds. The server also sends
// member_id, relationship, status and the rest, which the tests further down
// check on their own.
function basic(body) {
    return {
        rows: body.rows.map((row) => ({
            members: row.members.map(({ name, photo, is_self }) => ({ name, photo, is_self })),
        })),
        seeded: body.seeded,
    };
}

test("family tree requires a session", async () => {
    assert.equal((await request("GET", "/family")).status, 401);
    assert.equal((await request("PUT", "/family", { body: tree(["Mom"]) })).status, 401);
});

test("a new user starts with an empty, unseeded tree", async () => {
    const token = await signupAndLogin("newcomer", "newcomer@example.com");
    const got = await request("GET", "/family", { token });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { rows: [], seeded: false, parents_saved: false });
});

test("saved tree comes back on the next fetch", async () => {
    const token = await signupAndLogin("ada", "ada@example.com");
    const mine = tree(["Grandma", "Grandpa"], ["Mom", "Dad"], ["Me"]);

    const put = await request("PUT", "/family", { token, body: mine });
    assert.equal(put.status, 200);
    assert.deepEqual(basic(put.body), saved(["Grandma", "Grandpa"], ["Mom", "Dad"], ["Me"]));
    assert.deepEqual((await request("GET", "/family", { token })).body, put.body);
});

// The page uses `seeded` to decide whether to apply the starting layout from
// index.html. Without it, deleting every row would look like a new account and
// the default tree would come back and overwrite the deletion.
test("an emptied tree stays empty instead of being reseeded", async () => {
    const token = await signupAndLogin("cleared", "cleared@example.com");
    await request("PUT", "/family", { token, body: tree(["Grandma"], ["Mom"], ["Me"]) });

    const emptied = await request("PUT", "/family", { token, body: { rows: [] } });
    assert.deepEqual(emptied.body, { rows: [], seeded: true, parents_saved: false });

    // Still empty, and still flagged as seeded, on every later fetch.
    assert.deepEqual((await request("GET", "/family", { token })).body, { rows: [], seeded: true, parents_saved: false });
    assert.deepEqual((await request("GET", "/family", { token })).body, { rows: [], seeded: true, parents_saved: false });
});

test("seeded is per user", async () => {
    const one = await signupAndLogin("seeded1", "seeded1@example.com");
    const two = await signupAndLogin("seeded2", "seeded2@example.com");

    await request("PUT", "/family", { token: one, body: { rows: [] } });
    assert.equal((await request("GET", "/family", { token: one })).body.seeded, true);
    assert.equal((await request("GET", "/family", { token: two })).body.seeded, false);
});

test("a tree belongs only to the user who saved it", async () => {
    const ada = await signupAndLogin("ada2", "ada2@example.com");
    const grace = await signupAndLogin("grace", "grace@example.com");

    await request("PUT", "/family", { token: ada, body: tree(["Ada's mom"]) });
    assert.deepEqual((await request("GET", "/family", { token: grace })).body, { rows: [], seeded: false, parents_saved: false });

    await request("PUT", "/family", { token: grace, body: tree(["Grace's mom"]) });
    assert.deepEqual(basic((await request("GET", "/family", { token: ada })).body), saved(["Ada's mom"]));
    assert.deepEqual(basic((await request("GET", "/family", { token: grace })).body), saved(["Grace's mom"]));
});

test("saving replaces rows and members, including removals", async () => {
    const token = await signupAndLogin("edith", "edith@example.com");
    await request("PUT", "/family", { token, body: tree(["A", "B", "C"], ["D", "E"], ["F"]) });

    const shrunk = tree(["A", "B"], ["D"]);
    assert.deepEqual(basic((await request("PUT", "/family", { token, body: shrunk })).body), saved(["A", "B"], ["D"]));
    assert.deepEqual(basic((await request("GET", "/family", { token })).body), saved(["A", "B"], ["D"]));

    assert.deepEqual((await request("PUT", "/family", { token, body: { rows: [] } })).body, {
        rows: [],
        seeded: true,
        parents_saved: false,
    });
});

test("members that did not move keep their member_id across a save", async () => {
    const token = await signupAndLogin("stable", "stable@example.com");
    await request("PUT", "/family", { token, body: tree(["Grandma", "Grandpa"], ["Mom"]) });

    const idOf = (name) => db.prepare("SELECT member_id FROM family_members WHERE name = ?").get(name)?.member_id;
    const grandmaId = idOf("Grandma");

    // Rename someone else and add a member elsewhere.
    await request("PUT", "/family", { token, body: tree(["Grandma", "Grandfather"], ["Mom", "Dad"]) });
    assert.equal(idOf("Grandma"), grandmaId);
});

test("deleting rows cleans up their members", async () => {
    const token = await signupAndLogin("tidy", "tidy@example.com");
    await request("PUT", "/family", { token, body: tree(["Keep"], ["Drop1", "Drop2"]) });
    await request("PUT", "/family", { token, body: tree(["Keep"]) });

    const orphans = db
        .prepare("SELECT COUNT(*) AS n FROM family_members WHERE name IN ('Drop1', 'Drop2')")
        .get();
    assert.equal(orphans.n, 0);
});

test("blank names fall back to Unnamed", async () => {
    const token = await signupAndLogin("blank", "blank@example.com");
    const put = await request("PUT", "/family", { token, body: { rows: [{ members: [{ name: "   " }] }] } });
    assert.deepEqual(basic(put.body), saved(["Unnamed"]));
});

test("the is_self flag round-trips", async () => {
    const token = await signupAndLogin("selfflag", "selfflag@example.com");
    const body = {
        rows: [
            { members: [{ name: "Mom" }, { name: "Dad" }] },
            { members: [{ name: "Me", is_self: true }, { name: "Sister" }] },
        ],
    };

    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 200);

    const got = (await request("GET", "/family", { token })).body;
    assert.deepEqual(got.rows[1].members.map((m) => [m.name, m.is_self]), [
        ["Me", true],
        ["Sister", false],
    ]);
    assert.deepEqual(got.rows[0].members.map((m) => m.is_self), [false, false]);
});

test("the is_self flag survives edits elsewhere in the tree", async () => {
    const token = await signupAndLogin("selfstays", "selfstays@example.com");
    await request("PUT", "/family", {
        token,
        body: { rows: [{ members: [{ name: "Me", is_self: true }, { name: "Sister" }] }] },
    });

    // Remove the sibling; "Me" shifts position but stays flagged.
    const put = await request("PUT", "/family", {
        token,
        body: { rows: [{ members: [{ name: "Me", is_self: true }] }] },
    });
    assert.deepEqual(basic(put.body).rows[0].members, [{ name: "Me", photo: "profile.jpg", is_self: true }]);
});

test("a tree can only mark one member as you", async () => {
    const token = await signupAndLogin("twoselves", "twoselves@example.com");
    const body = {
        rows: [{ members: [{ name: "Me", is_self: true }, { name: "Also me", is_self: true }] }],
    };

    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 400);
    assert.match(put.body.error, /one family member/i);
});

test("malformed or oversized trees are rejected", async () => {
    const token = await signupAndLogin("bad", "bad@example.com");

    assert.equal((await request("PUT", "/family", { token, body: {} })).status, 400);
    assert.equal((await request("PUT", "/family", { token, body: { rows: "nope" } })).status, 400);
    assert.equal((await request("PUT", "/family", { token, body: { rows: [{}] } })).status, 400);

    const tooManyRows = { rows: Array.from({ length: 21 }, () => ({ members: [] })) };
    assert.equal((await request("PUT", "/family", { token, body: tooManyRows })).status, 400);

    const tooLongName = { rows: [{ members: [{ name: "x".repeat(101) }] }] };
    assert.equal((await request("PUT", "/family", { token, body: tooLongName })).status, 400);
});

test("a rejected save leaves the stored tree untouched", async () => {
    const token = await signupAndLogin("intact", "intact@example.com");
    await request("PUT", "/family", { token, body: tree(["Mom", "Dad"]) });

    await request("PUT", "/family", { token, body: { rows: [{ members: [{ name: "x".repeat(101) }] }] } });
    assert.deepEqual(basic((await request("GET", "/family", { token })).body), saved(["Mom", "Dad"]));
});

// ---- Member details, ids and invitations ----

async function signupWithId(username) {
    const email = `${username}@example.com`;
    const signup = await request("POST", "/signup", { body: { username, email, password: "password123" } });
    const token = (await request("POST", "/login", { body: { email, password: "password123" } })).body.token;
    return { id: signup.body.id, token };
}

async function makeFriends(a, b, bUsername) {
    await request("POST", "/friends/requests", { token: a.token, body: { username: bUsername } });
    const incoming = (await request("GET", "/friends/requests", { token: b.token })).body.incoming;
    await request("POST", `/friends/requests/${incoming[0].friendship_id}/accept`, { token: b.token });
}

test("relationship and email round-trip, and members get a status", async () => {
    const token = await signupAndLogin("details", "details@example.com");
    const body = {
        rows: [
            { members: [{ name: "Linda", relationship: "Mother", email: " Linda@Example.com " }] },
            { members: [{ name: "Me", is_self: true }] },
        ],
    };
    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 200);
    const [linda] = put.body.rows[0].members;
    assert.equal(linda.relationship, "Mother");
    assert.equal(linda.email, "linda@example.com");
    assert.equal(linda.status, "not_invited");
    assert.equal(typeof linda.member_id, "number");
    assert.equal(put.body.rows[1].members[0].status, "self");

    const badEmail = { rows: [{ members: [{ name: "X", email: "not-an-email" }] }] };
    assert.equal((await request("PUT", "/family", { token, body: badEmail })).status, 400);
});

test("a member moved to another generation keeps its member_id", async () => {
    const token = await signupAndLogin("mover", "mover@example.com");
    const first = (await request("PUT", "/family", { token, body: tree(["Aunt", "Uncle"], ["Cousin"]) })).body;
    const aunt = first.rows[0].members[0];

    const moved = {
        rows: [{ members: [first.rows[0].members[1]] }, { members: [first.rows[1].members[0], aunt] }],
    };
    const put = (await request("PUT", "/family", { token, body: moved })).body;
    assert.equal(put.rows[1].members[1].name, "Aunt");
    assert.equal(put.rows[1].members[1].member_id, aunt.member_id);
});

test("a member_id from someone else's tree is rejected", async () => {
    const one = await signupAndLogin("idowner", "idowner@example.com");
    const two = await signupAndLogin("idthief", "idthief@example.com");
    const theirs = (await request("PUT", "/family", { token: one, body: tree(["Secret"]) })).body;
    const memberId = theirs.rows[0].members[0].member_id;

    const put = await request("PUT", "/family", {
        token: two,
        body: { rows: [{ members: [{ member_id: memberId, name: "Mine now" }] }] },
    });
    assert.equal(put.status, 400);
    assert.equal((await request("GET", "/family", { token: one })).body.rows[0].members[0].name, "Secret");
    const invite = await request("POST", `/family/members/${memberId}/invite`, { token: two, body: {} });
    assert.equal(invite.status, 404);
});

test("only a friend can be added to the tree as a ReelLife account", async () => {
    const owner = await signupWithId("linkowner");
    const friend = await signupWithId("linkfriend");
    const stranger = await signupWithId("linkstranger");
    await makeFriends(owner, friend, "linkfriend");

    const withStranger = { rows: [{ members: [{ name: "Stranger", linked_user_id: stranger.id }] }] };
    assert.equal((await request("PUT", "/family", { token: owner.token, body: withStranger })).status, 400);

    const withFriend = { rows: [{ members: [{ name: "Friend", linked_user_id: friend.id }] }] };
    const put = await request("PUT", "/family", { token: owner.token, body: withFriend });
    assert.equal(put.status, 200);
    assert.equal(put.body.rows[0].members[0].status, "joined");
    assert.deepEqual(put.body.rows[0].members[0].linked_user, { id: friend.id, username: "linkfriend" });

    const twice = {
        rows: [
            {
                members: [
                    { name: "Friend", linked_user_id: friend.id },
                    { name: "Friend again", linked_user_id: friend.id },
                ],
            },
        ],
    };
    assert.equal((await request("PUT", "/family", { token: owner.token, body: twice })).status, 400);
});


test("an invitation links the new member and makes you friends", async () => {
    const owner = await signupWithId("inviter");
    const sister = await signupWithId("invitee");
    const first = (
        await request("PUT", "/family", {
            token: owner.token,
            body: { rows: [{ members: [{ name: "Me", is_self: true }, { name: "Emily", relationship: "Sister" }] }] },
        })
    ).body;
    const emily = first.rows[0].members[1];
    const invitePath = `/family/members/${emily.member_id}/invite`;

    const invite = await request("POST", invitePath, { token: owner.token, body: { email: "emily@example.com" } });
    assert.equal(invite.status, 200);
    assert.equal(invite.body.member.status, "invited");
    assert.equal(invite.body.member.email, "emily@example.com");
    const inviteToken = invite.body.token;

    // Asking again hands back the same link, so one already sent keeps working.
    assert.equal((await request("POST", invitePath, { token: owner.token, body: {} })).body.token, inviteToken);
    // The token itself is never part of the tree.
    const treeText = JSON.stringify((await request("GET", "/family", { token: owner.token })).body);
    assert.ok(!treeText.includes(inviteToken));

    const preview = await request("GET", `/family/invites/${inviteToken}`, { token: sister.token });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.from.username, "inviter");
    assert.deepEqual(preview.body.member, { name: "Emily", relationship: "Sister" });
    assert.equal(preview.body.own, false);

    // The owner can't accept their own link.
    assert.equal((await request("POST", `/family/invites/${inviteToken}/accept`, { token: owner.token })).status, 400);
    assert.equal((await request("POST", `/family/invites/${inviteToken}/accept`, { token: sister.token })).status, 200);

    const after = (await request("GET", "/family", { token: owner.token })).body.rows[0].members[1];
    assert.equal(after.status, "joined");
    assert.deepEqual(after.linked_user, { id: sister.id, username: "invitee" });
    const friends = (await request("GET", "/friends", { token: sister.token })).body;
    assert.deepEqual(friends.map((friend) => friend.username), ["inviter"]);

    // The link is used up, and there's no one left to invite.
    assert.equal((await request("GET", `/family/invites/${inviteToken}`, { token: sister.token })).status, 404);
    assert.equal((await request("POST", invitePath, { token: owner.token, body: {} })).status, 409);

    // Saving the tree again (as the page does after any edit) keeps the link.
    const resaved = await request("PUT", "/family", {
        token: owner.token,
        body: { rows: [{ members: [first.rows[0].members[0], { ...after, linked_user_id: sister.id }] }] },
    });
    assert.equal(resaved.status, 200);
    assert.equal(resaved.body.rows[0].members[1].status, "joined");
});

test("removing an invited member cancels the invitation", async () => {
    const owner = await signupWithId("canceller");
    const other = await signupWithId("cancelled");
    const first = (await request("PUT", "/family", { token: owner.token, body: tree(["Cousin"]) })).body;
    const memberId = first.rows[0].members[0].member_id;
    const invite = await request("POST", `/family/members/${memberId}/invite`, { token: owner.token, body: {} });

    await request("PUT", "/family", { token: owner.token, body: { rows: [] } });
    assert.equal((await request("GET", `/family/invites/${invite.body.token}`, { token: other.token })).status, 404);
    assert.equal((await request("GET", "/family/invites/nonsense", { token: other.token })).status, 404);
});

test("you can't invite yourself", async () => {
    const token = await signupAndLogin("selfinvite", "selfinvite@example.com");
    const body = { rows: [{ members: [{ name: "Me", is_self: true }] }] };
    const me = (await request("PUT", "/family", { token, body })).body.rows[0].members[0];
    const res = await request("POST", `/family/members/${me.member_id}/invite`, { token, body: {} });
    assert.equal(res.status, 400);
});

// ---- Parent links ----

// A tree given as rows of [name, parents?] pairs, parents being positions in
// the row above.
function linkedTree(...rows) {
    return {
        rows: rows.map((members) => ({
            members: members.map(([name, parents]) => ({ name, ...(parents ? { parents } : {}) })),
        })),
    };
}

const parentsOf = (body) => body.rows.map((row) => row.members.map((member) => member.parents));

test("parent links round-trip and mark the tree as having them", async () => {
    const token = await signupAndLogin("linker", "linker@example.com");
    const body = linkedTree([["Grandma"], ["Grandpa"]], [["Mom", [0, 1]], ["Aunt", [0, 1]], ["Dad"]], [["Me", [0, 2]]]);
    const put = await request("PUT", "/family", { token, body });
    assert.equal(put.status, 200);
    assert.equal(put.body.parents_saved, true);
    // Members sent without parents (the top row, Dad) have none.
    assert.deepEqual(parentsOf(put.body), [[[], []], [[0, 1], [0, 1], []], [[0, 2]]]);
    assert.deepEqual((await request("GET", "/family", { token })).body, put.body);
});

test("a tree saved without parents isn't marked as having them", async () => {
    const token = await signupAndLogin("unlinked", "unlinked@example.com");
    const put = await request("PUT", "/family", { token, body: tree(["Mom", "Dad"], ["Me"]) });
    assert.equal(put.body.parents_saved, false);
    assert.deepEqual(parentsOf(put.body), [[[], []], [[]]]);
});

test("parent links follow members by id when the row above is reordered", async () => {
    const token = await signupAndLogin("reorder", "reorder@example.com");
    const first = (
        await request("PUT", "/family", { token, body: linkedTree([["Mom"], ["Dad"]], [["Me", [1]]]) })
    ).body;
    const [mom, dad] = first.rows[0].members;
    const me = first.rows[1].members[0];

    // Dad moves to the front; Me is sent without parents, so keeps Dad.
    const swapped = {
        rows: [{ members: [dad, mom].map(({ member_id, name }) => ({ member_id, name })) }, { members: [{ member_id: me.member_id, name: "Me" }] }],
    };
    const put = (await request("PUT", "/family", { token, body: swapped })).body;
    assert.deepEqual(put.rows[1].members[0].parents, [0]);
    assert.equal(put.rows[0].members[0].name, "Dad");
});

test("removing a parent, or moving a child away from them, drops the link", async () => {
    const token = await signupAndLogin("unlinker", "unlinker@example.com");
    const first = (
        await request("PUT", "/family", {
            token,
            body: linkedTree([["Mom"], ["Dad"]], [["Me", [0, 1]], ["Sis", [0, 1]]], [["Kid"]]),
        })
    ).body;
    const ids = first.rows.map((row) => row.members.map(({ member_id, name }) => ({ member_id, name })));

    // Mom goes: Me and Sis keep only Dad, now at position 0.
    const withoutMom = { rows: [{ members: [ids[0][1]] }, { members: ids[1] }, { members: ids[2] }] };
    const put = (await request("PUT", "/family", { token, body: withoutMom })).body;
    assert.deepEqual(parentsOf(put), [[[]], [[0], [0]], [[]]]);

    // Sis moves down a generation: her link to Dad (now two rows up) goes.
    const moved = { rows: [{ members: [ids[0][1]] }, { members: [ids[1][0]] }, { members: [...ids[2], ids[1][1]] }] };
    const after = (await request("PUT", "/family", { token, body: moved })).body;
    assert.deepEqual(parentsOf(after), [[[]], [[0]], [[], []]]);
});

test("parents must be distinct people in the row directly above", async () => {
    const token = await signupAndLogin("badlinks", "badlinks@example.com");
    await request("PUT", "/family", { token, body: linkedTree([["Mom"]], [["Me", [0]]]) });
    for (const bad of [
        linkedTree([["Mom", [0]]]), // the top row has no one above it
        linkedTree([["Mom"]], [["Me", [1]]]), // past the end of the row above
        linkedTree([["Mom"]], [["Me", [0, 0]]]), // twice
        linkedTree([["Mom"]], [["Me", ["0"]]]), // not a position
        { rows: [{ members: [{ name: "Mom" }] }, { members: [{ name: "Me", parents: 0 }] }] }, // not a list
        linkedTree([["A"], ["B"], ["C"], ["D"], ["E"]], [["Me", [0, 1, 2, 3, 4]]]), // too many
    ]) {
        assert.equal((await request("PUT", "/family", { token, body: bad })).status, 400, JSON.stringify(bad));
    }
    // None of those changed what was saved.
    assert.deepEqual(parentsOf((await request("GET", "/family", { token })).body), [[[]], [[0]]]);
});


