// Tests for public/voiceInput.js (the microphone side of the spoken interview)
// against a fake SpeechRecognition, so the restart / echo-guard / privacy
// behaviour is checked without a browser. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = test;

const { createDictation, SPEECH_PAUSE_MS } = require("../public/voiceInput.js");

// Lets queued microtasks (the fake's onend after stop/abort) run.
const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

// A stand-in for Chrome's SpeechRecognition. Like the real one, start() throws
// if a session is already open, and stop()/abort() end with an onend event.
function makeEnv({ getUserMedia, online = true } = {}) {
    const state = { rec: null, tracksStopped: 0, mediaRequests: 0 };

    class FakeRecognition {
        constructor() {
            state.rec = this;
            this.active = false;
            this.startCalls = 0;
            this.stopCalls = 0;
            this.abortCalls = 0;
        }
        start() {
            if (this.active) throw new Error("InvalidStateError");
            this.active = true;
            this.startCalls += 1;
        }
        stop() {
            this.stopCalls += 1;
            this.finish();
        }
        abort() {
            this.abortCalls += 1;
            this.finish();
        }
        finish() {
            this.active = false;
            queueMicrotask(() => this.onend && this.onend());
        }
        // Events the browser would fire:
        started() {
            this.onstart();
        }
        ended() {
            this.active = false;
            this.onend();
        }
        errored(error) {
            this.onerror({ error });
        }
        heard(...phrases) {
            // phrases: [text, isFinal]
            const results = phrases.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
            this.onresult({ resultIndex: 0, results });
        }
    }

    const mediaDevices = Object.assign(new EventTarget(), {
        getUserMedia:
            getUserMedia ||
            (async () => {
                state.mediaRequests += 1;
                return { getTracks: () => [{ stop: () => (state.tracksStopped += 1) }] };
            }),
    });
    const env = {
        SpeechRecognition: FakeRecognition,
        window: new EventTarget(),
        document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
        navigator: { onLine: online, language: "en-US", mediaDevices },
    };
    return { env, state };
}

function recorder() {
    const log = { final: [], interim: [], listening: [], states: [], errors: [], pauses: 0 };
    const callbacks = {
        onFinalText: (text) => log.final.push(text),
        onInterimText: (text) => log.interim.push(text),
        onListeningChange: (on) => log.listening.push(on),
        onStateChange: (state) => log.states.push(state),
        onError: (message) => log.errors.push(message),
        onSpeechPause: () => (log.pauses += 1),
    };
    return { log, callbacks };
}

// A started, listening dictation.
async function listening(options) {
    const { env, state } = makeEnv(options);
    const { log, callbacks } = recorder();
    const dictation = createDictation(callbacks, env);
    assert.equal(await dictation.start(), true);
    state.rec.started();
    return { dictation, env, rec: state.rec, state, log };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
test.afterEach(() => mock.timers.reset());

test("returns null when the browser has no speech recognition", () => {
    assert.equal(createDictation({}, { SpeechRecognition: undefined }), null);
});

test("start asks for the microphone once, releases it, then listens", async () => {
    const { dictation, rec, state, log } = await listening();
    assert.equal(state.mediaRequests, 1);
    assert.equal(state.tracksStopped, 1, "the permission probe must not keep the mic open");
    assert.equal(rec.startCalls, 1);
    assert.equal(dictation.listening, true);
    assert.deepEqual(log.listening, [true]);
    assert.equal(dictation.state, "listening");

    dictation.stop();
    assert.equal(await dictation.start(), true);
    assert.equal(state.mediaRequests, 1, "permission is only asked the first time");
});

test("a blocked microphone is reported and recognition never starts", async () => {
    const { env, state } = makeEnv({
        getUserMedia: async () => {
            throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        },
    });
    const { log, callbacks } = recorder();
    const dictation = createDictation(callbacks, env);

    assert.equal(await dictation.start(), false);
    assert.equal(state.rec.startCalls, 0);
    assert.equal(dictation.listening, false);
    assert.equal(dictation.state, "blocked");
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0], /blocked/i);
});

test("no microphone and a busy microphone are told apart", async () => {
    for (const [name, pattern] of [
        ["NotFoundError", /No microphone was found/],
        ["NotReadableError", /busy in another app/],
    ]) {
        const { env } = makeEnv({
            getUserMedia: async () => {
                throw Object.assign(new Error(name), { name });
            },
        });
        const { log, callbacks } = recorder();
        const dictation = createDictation(callbacks, env);
        assert.equal(await dictation.start(), false);
        assert.equal(dictation.state, "no-microphone");
        assert.match(log.errors[0], pattern);
    }
});

test("finished phrases and the phrase in progress are reported separately", async () => {
    const { rec, log } = await listening();
    rec.heard(["I grew up", true], ["by the riv", false]);
    assert.deepEqual(log.final, ["I grew up"]);
    assert.equal(log.interim.at(-1), "by the riv");
});

test("Chrome ending the session restarts it after a short delay, not synchronously", async () => {
    const { rec } = await listening();
    rec.ended();
    assert.equal(rec.startCalls, 1, "must not restart inside onend");
    mock.timers.tick(149);
    assert.equal(rec.startCalls, 1);
    mock.timers.tick(1);
    assert.equal(rec.startCalls, 2);
});

test("repeated failures back off instead of hammering start()", async () => {
    const { rec } = await listening();
    // Each restart dies before onstart: delays double 150, 300, 600...
    rec.ended();
    mock.timers.tick(150);
    assert.equal(rec.startCalls, 2);
    rec.ended();
    mock.timers.tick(150);
    assert.equal(rec.startCalls, 2, "second delay is longer than the first");
    mock.timers.tick(150);
    assert.equal(rec.startCalls, 3);
});

test("words still being heard when the session ends count as said", async () => {
    const { rec, log } = await listening();
    rec.heard(["and then we moved", false]);
    rec.ended();
    assert.deepEqual(log.final, ["and then we moved"]);
});

test("suspend() stops listening but keeps the mic on, and ignores the interviewer's voice", async () => {
    const { dictation, rec, log } = await listening();
    dictation.suspend();
    await settle();
    assert.equal(rec.abortCalls, 1);
    assert.equal(dictation.listening, true, "the mic is still 'on' from the user's point of view");
    assert.deepEqual(log.listening, [true], "no off/on flicker");

    rec.heard(["Which stage of your life", true]); // the question coming back through the speakers
    assert.deepEqual(log.final, []);

    mock.timers.tick(10000);
    assert.equal(rec.startCalls, 1, "nothing restarts while suspended");

    dictation.resume();
    assert.equal(rec.startCalls, 2);
});

test("resume() does nothing if the user switched the mic off meanwhile", async () => {
    const { dictation, rec } = await listening();
    dictation.suspend();
    await settle();
    dictation.stop();
    dictation.resume();
    mock.timers.tick(10000);
    assert.equal(rec.startCalls, 1);
});

test("stop() still delivers the last words Chrome heard", async () => {
    const { dictation, rec, log } = await listening();
    dictation.stop();
    assert.equal(rec.stopCalls, 1);
    assert.equal(rec.abortCalls, 0);
    rec.heard(["one last thing", true]);
    assert.deepEqual(log.final, ["one last thing"]);
    assert.deepEqual(log.listening, [true, false]);
});

test("finish() turns the mic off and waits for the last words", async () => {
    const { dictation, rec, log } = await listening();
    rec.heard(["and that was the last", false]);
    let done = false;
    const finished = dictation.finish().then(() => (done = true));
    assert.equal(dictation.listening, false);
    assert.equal(rec.stopCalls, 1, "stop(), not abort(), so Chrome hands the words over");
    assert.equal(done, false, "still waiting for Chrome");
    await finished; // the fake's onend fires on a microtask
    assert.deepEqual(log.final, ["and that was the last"], "the phrase in progress counts as said");
});

test("finish() gives up waiting if Chrome never reports back", async () => {
    const { dictation, rec } = await listening();
    rec.finish = () => {}; // no onend, ever
    let done = false;
    const finished = dictation.finish().then(() => (done = true));
    await settle();
    assert.equal(done, false);
    mock.timers.tick(1500);
    await finished;
    assert.equal(done, true);
});

test("finish() resolves straight away when the mic is already off", async () => {
    const { env } = makeEnv();
    const dictation = createDictation(recorder().callbacks, env);
    await dictation.finish();
    assert.equal(dictation.listening, false);
});

test("stop({ discard: true }) aborts and drops words not yet handed over", async () => {
    const { dictation, rec, log } = await listening();
    rec.heard(["half a sentence", false]);
    dictation.stop({ discard: true });
    assert.equal(rec.abortCalls, 1);
    rec.heard(["late result", true]);
    await settle(); // onend fires
    assert.deepEqual(log.final, [], "nothing leaks out after a discard");
    assert.equal(log.interim.at(-1), "");
    assert.equal(dictation.listening, false);
});

test("a discard doesn't poison the next time the mic is switched on", async () => {
    const { dictation, rec, log } = await listening();
    dictation.stop({ discard: true });
    await settle();
    await dictation.start();
    rec.started();
    rec.heard(["fresh start", true]);
    assert.deepEqual(log.final, ["fresh start"]);
});

test("the microphone is released while the tab is hidden and resumes when it's back", async () => {
    const { dictation, env, rec } = await listening();
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert.equal(rec.abortCalls, 1);
    mock.timers.tick(20000);
    assert.equal(rec.startCalls, 1, "never listens from a background tab");
    assert.equal(dictation.listening, true);

    env.document.visibilityState = "visible";
    env.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(rec.startCalls, 2);
});

test("coming back online restarts listening without waiting out the backoff", async () => {
    const { env, rec } = await listening();
    rec.errored("network");
    rec.ended();
    env.window.dispatchEvent(new Event("online"));
    assert.equal(rec.startCalls, 2);
});

test("errors set a state the page can show", async () => {
    const { dictation, env, rec } = await listening();
    rec.errored("network");
    assert.equal(dictation.state, "reconnecting");

    env.navigator.onLine = false;
    rec.errored("network");
    assert.equal(dictation.state, "offline");

    rec.errored("audio-capture");
    assert.equal(dictation.state, "no-microphone");
    assert.equal(dictation.listening, true, "keeps retrying in case the mic is plugged back in");
});

test("silence and our own aborts are not errors", async () => {
    const { rec, log } = await listening();
    rec.errored("no-speech");
    rec.errored("aborted");
    assert.deepEqual(log.errors, []);
});

test("permission revoked mid-interview turns the mic off and says why", async () => {
    const { dictation, rec, log } = await listening();
    rec.errored("not-allowed");
    assert.equal(dictation.listening, false);
    assert.equal(dictation.state, "blocked");
    assert.deepEqual(log.listening, [true, false]);
    assert.match(log.errors[0], /blocked/i);
    rec.ended();
    mock.timers.tick(20000);
    assert.equal(rec.startCalls, 1, "doesn't keep retrying a blocked mic");
});

test("an unfamiliar error is reported once, not on every restart", async () => {
    const { rec, log } = await listening();
    rec.errored("language-not-supported");
    rec.errored("language-not-supported");
    assert.equal(log.errors.length, 1);
});

test("onSpeechPause fires once after the storyteller goes quiet", async () => {
    const { rec, log } = await listening();
    rec.heard(["That was the summer of 1962.", true]);
    mock.timers.tick(SPEECH_PAUSE_MS - 1);
    assert.equal(log.pauses, 0);
    mock.timers.tick(1);
    assert.equal(log.pauses, 1);
    mock.timers.tick(30000);
    assert.equal(log.pauses, 1, "silence alone isn't an answer");
});

test("more talking pushes the pause back, and words still coming in hold it off", async () => {
    const { rec, log } = await listening();
    rec.heard(["First part,", true]);
    mock.timers.tick(1000);
    // A long phrase: the browser keeps updating it while it is spoken.
    for (const words of ["and the", "and the second", "and the second part"]) {
        rec.heard([words, false]);
        mock.timers.tick(SPEECH_PAUSE_MS - 100);
    }
    assert.equal(log.pauses, 0, "a phrase is still being heard");
    assert.equal(rec.stopCalls, 0);
    rec.heard(["and the second part.", true]);
    mock.timers.tick(SPEECH_PAUSE_MS);
    assert.equal(log.pauses, 1);
    assert.equal(rec.stopCalls, 0, "everything was final -- no need to cut the session");
});

test("suspend() cancels a pending pause so a question can't trigger a send", async () => {
    const { dictation, rec, log } = await listening();
    rec.heard(["something", true]);
    dictation.suspend();
    mock.timers.tick(SPEECH_PAUSE_MS * 2);
    assert.equal(log.pauses, 0);
});

test("a pause with the last words still unfinished asks for them, then fires once they're in", async () => {
    const { dictation, rec, log } = await listening();
    // Safari (and sometimes Chrome) never marks the last phrase final until
    // the session ends -- the pause mustn't wait for that forever.
    rec.heard(["We grew tomatoes on the balcony", false]);
    mock.timers.tick(SPEECH_PAUSE_MS - 1);
    assert.equal(rec.stopCalls, 0, "still talking");
    mock.timers.tick(1);
    assert.equal(rec.stopCalls, 1, "asked the browser to hand over the words");
    assert.equal(log.pauses, 0, "not before the words are in the box");
    await settle(); // the fake's onend
    assert.deepEqual(log.final, ["We grew tomatoes on the balcony"]);
    assert.equal(log.pauses, 1);
    assert.equal(dictation.listening, true, "the mic stays on");
    mock.timers.tick(1000);
    assert.ok(rec.startCalls >= 2, "and listening restarts for the next answer");
    mock.timers.tick(30000);
    assert.equal(log.pauses, 1, "fires once");
});

test("a pause whose stop() is never answered falls back to abort()", async () => {
    const { rec, log } = await listening();
    rec.stop = function () {
        this.stopCalls += 1; // a browser that ignores stop()
    };
    rec.heard(["The summer of 1962", false]);
    mock.timers.tick(SPEECH_PAUSE_MS);
    assert.equal(rec.stopCalls, 1);
    assert.equal(rec.abortCalls, 0);
    mock.timers.tick(1500);
    assert.equal(rec.abortCalls, 1);
    await settle();
    assert.deepEqual(log.final, ["The summer of 1962"]);
    assert.equal(log.pauses, 1);
});

test("turning the mic off while a pause is collecting the last words doesn't fire it", async () => {
    const { dictation, rec, log } = await listening();
    rec.heard(["half a sentence", false]);
    mock.timers.tick(SPEECH_PAUSE_MS);
    dictation.stop({ discard: true });
    await settle();
    mock.timers.tick(5000);
    assert.equal(log.pauses, 0);
    assert.deepEqual(log.final, []);
});

test("the watchdog retries a start() that never reported back", async () => {
    const { env, state } = makeEnv();
    const { callbacks } = recorder();
    const dictation = createDictation(callbacks, env);
    await dictation.start(); // recognition.start() called, onstart never fires
    assert.equal(state.rec.startCalls, 1);

    mock.timers.tick(12000);
    await settle();
    mock.timers.tick(10000);
    assert.ok(state.rec.abortCalls >= 1, "stuck session was aborted");
    assert.ok(state.rec.startCalls >= 2, "and started again");
});

test("a second start() while the first is awaiting permission doesn't open two sessions", async () => {
    const { env, state } = makeEnv();
    const { callbacks } = recorder();
    const dictation = createDictation(callbacks, env);
    const [a, b] = await Promise.all([dictation.start(), dictation.start()]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(state.rec.startCalls, 1);
    assert.equal(state.mediaRequests, 1);
});
