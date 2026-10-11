// Tests for public/sessionWatch.js -- the page's own check that the person is
// still signed in (as the same account) while a spoken interview is running.
// The server enforces the session on every call regardless (see
// interview.test.js); this covers the client noticing in between.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = test;

const { createSessionWatch } = require("../public/sessionWatch.js");

const TOKEN_KEY = "reellife_token";

function makeWatch({ user = { id: 1 }, signedIn = true, intervalMs = 60000 } = {}) {
    const ctl = { user, signedIn, checks: 0, failure: null };
    const lost = [];
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const watch = createSessionWatch(
        {
            check: async () => {
                ctl.checks += 1;
                if (ctl.failure) throw ctl.failure;
                return ctl.user;
            },
            isSignedIn: () => ctl.signedIn,
            tokenKey: TOKEN_KEY,
            onLost: (reason) => lost.push(reason),
            intervalMs,
        },
        { window: win, document: doc }
    );
    return { watch, ctl, lost, win, doc };
}

const unauthorized = () => Object.assign(new Error("Invalid or expired session"), { status: 401 });
const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

test.beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
test.afterEach(() => mock.timers.reset());

test("a valid session stays valid", async () => {
    const { watch, lost, ctl } = makeWatch();
    assert.equal(await watch.verify(), true);
    assert.equal(ctl.checks, 1);
    assert.deepEqual(lost, []);
});

test("no token in this browser is lost at once, without asking the server", async () => {
    const { watch, lost, ctl } = makeWatch({ signedIn: false });
    assert.equal(await watch.verify(), false);
    assert.deepEqual(lost, ["signed-out"]);
    assert.equal(ctl.checks, 0);
});

test("a 401 from the server means the session expired", async () => {
    const { watch, lost, ctl } = makeWatch();
    ctl.failure = unauthorized();
    assert.equal(await watch.verify(), false);
    assert.deepEqual(lost, ["expired"]);
});

test("a network failure is not treated as signed out", async () => {
    const { watch, lost, ctl } = makeWatch();
    ctl.failure = new TypeError("Failed to fetch");
    assert.equal(await watch.verify(), true);
    ctl.failure = Object.assign(new Error("Internal server error"), { status: 500 });
    assert.equal(await watch.verify(), true);
    assert.deepEqual(lost, []);
});

test("a different account answering is caught", async () => {
    const { watch, lost, ctl } = makeWatch({ user: { id: 7 } });
    assert.equal(await watch.verify(), true); // baseline: user 7
    ctl.user = { id: 8 };
    assert.equal(await watch.verify(), false);
    assert.deepEqual(lost, ["changed"]);
});

test("the same account signing in again (new token) is fine", async () => {
    const { watch, lost, ctl } = makeWatch({ user: { id: 7 } });
    await watch.verify();
    ctl.user = { id: 7 };
    assert.equal(await watch.verify(), true);
    assert.deepEqual(lost, []);
});

test("onLost fires once, and a lost session stays lost", async () => {
    const { watch, lost, ctl } = makeWatch();
    ctl.failure = unauthorized();
    await watch.verify();
    await watch.verify();
    ctl.failure = null;
    assert.equal(await watch.verify(), false, "recovering isn't possible; the page must sign in again");
    assert.deepEqual(lost, ["expired"]);
    assert.equal(watch.lost, true);
});

test("overlapping checks share one request", async () => {
    const { watch, ctl } = makeWatch();
    const results = await Promise.all([watch.verify(), watch.verify(), watch.verify()]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(ctl.checks, 1);
});

test("start() takes a baseline straight away and re-checks on a schedule", async () => {
    const { watch, ctl, lost } = makeWatch({ intervalMs: 60000 });
    watch.start();
    await settle();
    assert.equal(ctl.checks, 1);

    mock.timers.tick(60000);
    await settle();
    assert.equal(ctl.checks, 2);

    ctl.failure = unauthorized();
    mock.timers.tick(60000);
    await settle();
    assert.deepEqual(lost, ["expired"]);

    mock.timers.tick(600000);
    await settle();
    assert.equal(ctl.checks, 3, "stops polling once lost");
});

test("another tab changing the token triggers a check", async () => {
    const { watch, ctl, lost, win } = makeWatch();
    watch.start();
    await settle();
    ctl.signedIn = false; // the other tab logged out
    win.dispatchEvent(Object.assign(new Event("storage"), { key: TOKEN_KEY }));
    await settle();
    assert.deepEqual(lost, ["signed-out"]);
});

test("unrelated storage changes are ignored", async () => {
    const { watch, ctl, win } = makeWatch();
    watch.start();
    await settle();
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "reellife_voice_questions" }));
    await settle();
    assert.equal(ctl.checks, 1);
});

test("coming back to the tab or back online re-checks; hiding does not", async () => {
    const { watch, ctl, win, doc } = makeWatch();
    watch.start();
    await settle();

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert.equal(ctl.checks, 1);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert.equal(ctl.checks, 2);

    win.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(ctl.checks, 3);
});

test("stop() removes the timers and listeners", async () => {
    const { watch, ctl, win } = makeWatch();
    watch.start();
    await settle();
    watch.stop();
    mock.timers.tick(600000);
    win.dispatchEvent(new Event("online"));
    win.dispatchEvent(Object.assign(new Event("storage"), { key: TOKEN_KEY }));
    await settle();
    assert.equal(ctl.checks, 1);
});
