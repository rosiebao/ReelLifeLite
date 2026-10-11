// Reads the interviewer's questions aloud with the browser's built-in
// text-to-speech. Ported from ReelLife's src/js/interview.js. The question is
// always shown as a chat bubble too -- the voice is in addition, never instead.
//
// The page listens to onSpeakingChange to switch the microphone off while a
// question plays (otherwise recognition transcribes the interviewer's own voice
// as the storyteller's answer) and back on afterwards.
//
// Wrapped in a function so its helpers stay out of the page's global scope
// (classic scripts share one), and so tests can load it in Node with fakes.
(function (root) {
    // localStorage key for the "read questions aloud" toggle ('on' by default).
    const VOICE_PREFERENCE_KEY = "reellife_voice_questions";
    // Chrome sometimes never fires onend for an utterance. If the question
    // hasn't finished well after it should have, carry on so the microphone
    // isn't left switched off.
    const MIN_SPEAK_BUDGET_MS = 8000;
    const SPEAK_BUDGET_PER_CHAR_MS = 120;

    function browserEnv() {
        let storage = null;
        try {
            storage = root.localStorage;
        } catch (err) {
            /* storage blocked */
        }
        return {
            speechSynthesis: root.speechSynthesis,
            SpeechSynthesisUtterance: root.SpeechSynthesisUtterance,
            storage,
        };
    }

    // The model writes markdown (**bold**, bullets); read the words, not the
    // marks. Split into sentences because Chrome stops long utterances after ~15s.
    function speechChunks(text) {
        const plain = String(text || "")
            .replace(/```[\s\S]*?```/g, " ")
            .replace(/[*_`#>]+/g, "")
            .replace(/^\s*[-•]\s+/gm, "")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
            .trim();
        return plain
            .split(/(?<=[.!?])\s+|\n+/)
            .map((sentence) => sentence.trim())
            .filter(Boolean);
    }

    // A warm, natural-sounding English voice when the system has one.
    function pickVoice(voices) {
        const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.lang));
        const preferences = [
            /natural/i,
            /enhanced|premium/i,
            /samantha/i,
            /google us english/i,
            /ava|allison|susan|karen|moira|serena|zoe/i,
        ];
        for (const pattern of preferences) {
            const match = english.find((voice) => pattern.test(voice.name));
            if (match) return match;
        }
        return english.find((voice) => voice.lang === "en-US") || english[0] || null;
    }

    // Returns null when the browser has no text-to-speech; the page hides the
    // voice controls then and questions are text only.
    function createSpeaker({ onSpeakingChange } = {}, env = browserEnv()) {
        const { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance, storage } = env;
        if (!synth || !Utterance) return null;

        // Voices load asynchronously; asking once makes them available sooner.
        synth.getVoices();

        let enabled = true;
        try {
            enabled = !storage || storage.getItem(VOICE_PREFERENCE_KEY) !== "off";
        } catch (err) {
            /* storage blocked: default to on */
        }

        let speaking = false;
        // Kept referenced until they finish: Chrome can garbage-collect an
        // utterance mid-sentence and then never fire its onend.
        let activeUtterances = [];
        let budgetTimer = null;

        function setSpeaking(value) {
            if (speaking === value) return;
            speaking = value;
            if (onSpeakingChange) onSpeakingChange(value);
        }

        // Silences whatever is playing without treating it as finished (so the
        // microphone isn't briefly switched back on between two questions).
        function cancel() {
            clearTimeout(budgetTimer);
            budgetTimer = null;
            // Detach handlers first so cancelling doesn't count as a finished question.
            activeUtterances.forEach((utterance) => {
                utterance.onend = null;
                utterance.onerror = null;
            });
            activeUtterances = [];
            synth.cancel();
        }

        function finish() {
            if (!speaking) return;
            cancel();
            setSpeaking(false);
        }

        // force: speak even though the voice toggle is off (the 🔊 Listen button).
        function speak(text, { force = false } = {}) {
            if (!force && !enabled) return false;
            const chunks = speechChunks(text);
            if (chunks.length === 0) return false;

            cancel();
            setSpeaking(true);

            const voice = pickVoice(synth.getVoices());
            let remaining = chunks.length;
            activeUtterances = chunks.map((chunk) => {
                const utterance = new Utterance(chunk);
                if (voice) {
                    utterance.voice = voice;
                    utterance.lang = voice.lang;
                } else {
                    utterance.lang = "en-US";
                }
                utterance.rate = 0.95; // a little unhurried
                utterance.pitch = 1;
                utterance.onend = () => {
                    remaining -= 1;
                    if (remaining === 0) finish();
                };
                utterance.onerror = (event) => {
                    // 'not-allowed' is the browser's autoplay rule: nothing on
                    // the page has been clicked yet. The Listen button still works.
                    if (event.error !== "canceled" && event.error !== "interrupted") {
                        console.warn("Could not read the question aloud:", event.error);
                    }
                    finish();
                };
                return utterance;
            });

            budgetTimer = setTimeout(
                finish,
                Math.max(MIN_SPEAK_BUDGET_MS, chunks.join(" ").length * SPEAK_BUDGET_PER_CHAR_MS)
            );

            // Chrome can be left paused (e.g. after a tab switch); resume before queueing.
            synth.resume();
            activeUtterances.forEach((utterance) => synth.speak(utterance));
            return true;
        }

        return {
            get enabled() {
                return enabled;
            },
            get speaking() {
                return speaking;
            },

            speak,

            // Silences the question (e.g. the storyteller answered over it).
            stop() {
                cancel();
                setSpeaking(false);
            },

            // The header toggle, remembered across interviews.
            setEnabled(value) {
                enabled = Boolean(value);
                try {
                    if (storage) storage.setItem(VOICE_PREFERENCE_KEY, enabled ? "on" : "off");
                } catch (err) {
                    /* storage blocked: the choice just won't be remembered */
                }
                if (!enabled) this.stop();
                return enabled;
            },
        };
    }

    const api = { createSpeaker, speechChunks, pickVoice, VOICE_PREFERENCE_KEY };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof window !== "undefined" ? window : globalThis);
