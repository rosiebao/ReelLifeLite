// Tests for public/voiceOutput.js (the interviewer reading questions aloud)
// against a fake speechSynthesis. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = test;

const { createSpeaker, speechChunks, pickVoice, VOICE_PREFERENCE_KEY } = require("../public/voiceOutput.js");

function makeEnv({ voices = [], stored } = {}) {
    const synth = {
        spoken: [],
        cancelled: 0,
        resumed: 0,
        getVoices: () => voices,
        speak(utterance) {
            this.spoken.push(utterance);
        },
        cancel() {
            this.cancelled += 1;
        },
        resume() {
            this.resumed += 1;
        },
    };
    class Utterance {
        constructor(text) {
            this.text = text;
        }
    }
    const data = new Map(stored === undefined ? [] : [[VOICE_PREFERENCE_KEY, stored]]);
    const storage = {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, value),
    };
    return { env: { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance, storage }, synth, data };
}

function makeSpeaker(options) {
    const { env, synth, data } = makeEnv(options);
    const changes = [];
    const speaker = createSpeaker({ onSpeakingChange: (speaking) => changes.push(speaking) }, env);
    return { speaker, synth, changes, data };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

test("speechChunks reads the words, not the markdown", () => {
    assert.deepEqual(speechChunks("**Welcome back.** Tell me about your [home](http://x.test)! 😀 What was it like?"), [
        "Welcome back.",
        "Tell me about your home!",
        "What was it like?",
    ]);
    assert.deepEqual(speechChunks("- first\n- second\n```js\ncode()\n```"), ["first", "second"]);
    assert.deepEqual(speechChunks("  "), []);
    assert.deepEqual(speechChunks(null), []);
});

test("pickVoice prefers a natural English voice and ignores other languages", () => {
    const voices = [
        { name: "Hortense", lang: "fr-FR" },
        { name: "Microsoft David", lang: "en-US" },
        { name: "Microsoft Aria Online (Natural)", lang: "en-US" },
    ];
    assert.equal(pickVoice(voices).name, "Microsoft Aria Online (Natural)");
    assert.equal(pickVoice([voices[0], voices[1]]).name, "Microsoft David");
    assert.equal(pickVoice([voices[0]]), null);
    assert.equal(pickVoice([]), null);
});

test("no speech synthesis means no speaker", () => {
    assert.equal(createSpeaker({}, { speechSynthesis: undefined }), null);
});

test("a question is read sentence by sentence, and speaking ends with the last one", () => {
    const { speaker, synth, changes } = makeSpeaker();
    assert.equal(speaker.speak("Where did you grow up? What was it like?"), true);
    assert.deepEqual(
        synth.spoken.map((u) => u.text),
        ["Where did you grow up?", "What was it like?"]
    );
    assert.equal(speaker.speaking, true);
    assert.deepEqual(changes, [true]);

    synth.spoken[0].onend();
    assert.equal(speaker.speaking, true, "still on the second sentence");
    synth.spoken[1].onend();
    assert.equal(speaker.speaking, false);
    assert.deepEqual(changes, [true, false]);
});

test("a new question replaces the old one without flickering 'not speaking'", () => {
    const { speaker, synth, changes } = makeSpeaker();
    speaker.speak("First question?");
    const first = synth.spoken[0];
    speaker.speak("Second question?");
    assert.deepEqual(changes, [true], "the mic must not be switched back on in between");
    assert.equal(first.onend, null, "the cancelled question can no longer finish the new one");
    assert.equal(synth.cancelled, 2);
});

test("stop() silences the question and reports it", () => {
    const { speaker, changes } = makeSpeaker();
    speaker.speak("Tell me more?");
    speaker.stop();
    assert.equal(speaker.speaking, false);
    assert.deepEqual(changes, [true, false]);
    speaker.stop();
    assert.deepEqual(changes, [true, false], "stopping when silent is a no-op");
});

test("when voice is off nothing is spoken, except for the Listen button", () => {
    const { speaker, synth } = makeSpeaker({ stored: "off" });
    assert.equal(speaker.enabled, false);
    assert.equal(speaker.speak("Quiet question?"), false);
    assert.equal(synth.spoken.length, 0);

    assert.equal(speaker.speak("Read me this one?", { force: true }), true);
    assert.equal(synth.spoken.length, 1);
});

test("the voice choice is remembered, and muting silences what's playing", () => {
    const { speaker, data, changes } = makeSpeaker();
    assert.equal(speaker.enabled, true, "on by default");
    speaker.speak("Hello there?");
    assert.equal(speaker.setEnabled(false), false);
    assert.equal(data.get(VOICE_PREFERENCE_KEY), "off");
    assert.equal(speaker.speaking, false);
    assert.deepEqual(changes, [true, false]);
    speaker.setEnabled(true);
    assert.equal(data.get(VOICE_PREFERENCE_KEY), "on");
});

test("broken browser storage doesn't break the speaker", () => {
    const { env } = makeEnv();
    env.storage = {
        getItem() {
            throw new Error("blocked");
        },
        setItem() {
            throw new Error("blocked");
        },
    };
    const speaker = createSpeaker({}, env);
    assert.equal(speaker.enabled, true);
    assert.doesNotThrow(() => speaker.setEnabled(false));
});

test("an utterance error ends the question so the mic can come back", () => {
    const warn = mock.method(console, "warn", () => {});
    const { speaker, synth, changes } = makeSpeaker();
    speaker.speak("Why?");
    synth.spoken[0].onerror({ error: "synthesis-failed" });
    assert.deepEqual(changes, [true, false]);
    assert.equal(warn.mock.callCount(), 1);
    warn.mock.restore();
});

test("if the browser never reports the end, speaking times out", () => {
    const { speaker, changes } = makeSpeaker();
    speaker.speak("Short one?");
    mock.timers.tick(7999);
    assert.equal(speaker.speaking, true);
    mock.timers.tick(1);
    assert.equal(speaker.speaking, false);
    assert.deepEqual(changes, [true, false]);
});

test("the timeout is cleared when the question finishes normally", () => {
    const { speaker, synth, changes } = makeSpeaker();
    speaker.speak("Short one?");
    synth.spoken[0].onend();
    speaker.speak("Another?");
    mock.timers.tick(7999);
    assert.equal(speaker.speaking, true, "the first question's timer must not cut the second short");
    assert.deepEqual(changes, [true, false, true]);
});
