// Speech-to-text for answering the interviewer out loud, using the browser's
// Web Speech API (Chrome, Edge, Safari -- not Firefox). Ported from ReelLife's
// src/js/interview.js, including the parts that keep the microphone reliable.
//
// Why it isn't just recognition.start() / onend -> start():
//  * Chrome ends recognition on its own (silence, ~60s limit, network blips).
//    Restarting synchronously inside onend throws and leaves the mic dead, so
//    every restart goes through a short delay with backoff, plus a watchdog
//    that restarts listening if it ever silently stops.
//  * The interviewer's own voice must not be transcribed as the answer, so the
//    page suspend()s listening while a question is read aloud (voiceOutput.js).
//  * Errors (offline, no microphone, blocked) are reported as a state the page
//    can show, instead of the mic quietly doing nothing.
//
// Security / privacy: the microphone is only ever open while the storyteller
// has switched it on. It is released when the tab is hidden, and the page can
// stop({ discard: true }) -- used when the sign-in is lost -- to drop any words
// not yet handed over (see sessionWatch.js and testChat.js).
//
// Wrapped in a function so its helpers stay out of the page's global scope
// (classic scripts share one), and so tests can load it in Node with fakes.
(function (root) {
    // Words arrive as short "final" phrases. onSpeechPause fires once the
    // storyteller has been quiet this long, for the page's hands-free mode.
    const SPEECH_PAUSE_MS = 1500;
    // Restart quickly after Chrome ends a session; back off after real errors.
    const RESTART_BASE_DELAY_MS = 150;
    const RESTART_MAX_DELAY_MS = 5000;
    // Safety net for a missed event: how often to check, and how long start()
    // may go unanswered before it is retried.
    const WATCHDOG_INTERVAL_MS = 4000;
    const START_STUCK_MS = 8000;

    const MESSAGES = {
        blocked: "Microphone access was blocked. Allow it in the browser's site settings to answer out loud.",
        missing: "No microphone was found. Plug one in (or choose one in your sound settings), then tap the microphone again.",
        busy: "The microphone is busy in another app. Close that app, then tap the microphone again.",
    };

    function browserEnv() {
        return {
            SpeechRecognition: root.SpeechRecognition || root.webkitSpeechRecognition,
            window: root,
            document: root.document,
            navigator: root.navigator,
        };
    }

    // Returns null when the browser can't do speech recognition; testChat.js
    // hides the mic button then.
    //
    // Callbacks: onFinalText(text), onInterimText(text), onListeningChange(bool)
    // -- the mic switched on/off by the user -- onStateChange(state), onError(msg)
    // and onSpeechPause(). `state` is one of 'idle' | 'connecting' | 'listening'
    // | 'reconnecting' | 'offline' | 'no-microphone' | 'blocked'.
    function createDictation(callbacks = {}, env = browserEnv()) {
        const { SpeechRecognition, window: win, document: doc, navigator: nav } = env;
        if (!SpeechRecognition) return null;

        const noop = () => {};
        const onFinalText = callbacks.onFinalText || noop;
        const onInterimText = callbacks.onInterimText || noop;
        const onListeningChange = callbacks.onListeningChange || noop;
        const onStateChange = callbacks.onStateChange || noop;
        const onError = callbacks.onError || noop;
        const onSpeechPause = callbacks.onSpeechPause || noop;

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = (nav && nav.language) || "en-US";

        let wanted = false; // the storyteller switched the mic on
        let suspended = false; // a question is being read aloud
        let ignoreResults = false; // stop({ discard }) -- drop whatever is in flight
        let running = false; // between onstart and onend
        let starting = false; // start() called, onstart not yet fired
        let startRequestedAt = 0;
        let restartTimer = null;
        let restartAttempts = 0;
        let watchdogTimer = null;
        let pauseTimer = null;
        let heardSincePause = false;
        let lastInterim = "";
        let state = "idle";
        let permissionGranted = false;
        let permissionRequest = null;
        let reportedError = null;

        function setState(next) {
            if (state === next) return;
            state = next;
            onStateChange(next);
        }

        function hidden() {
            return Boolean(doc) && doc.visibilityState === "hidden";
        }

        // Listening is wanted when the mic is on, the interviewer isn't
        // talking, and the tab is on screen (never listen from a background tab).
        function shouldListen() {
            return wanted && !suspended && !hidden();
        }

        function clearRestartTimer() {
            clearTimeout(restartTimer);
            restartTimer = null;
        }

        function clearPauseTimer() {
            clearTimeout(pauseTimer);
            pauseTimer = null;
            heardSincePause = false;
        }

        function startListening() {
            if (!shouldListen()) return;
            clearRestartTimer();
            if (running || starting) return;
            try {
                starting = true;
                startRequestedAt = Date.now();
                recognition.start();
                if (state !== "reconnecting" && state !== "offline") setState("connecting");
            } catch (err) {
                // InvalidStateError: the previous session hasn't finished closing yet.
                starting = false;
                scheduleRestart();
            }
        }

        function scheduleRestart(delay) {
            if (!shouldListen() || restartTimer) return;
            const wait = delay ?? Math.min(RESTART_BASE_DELAY_MS * 2 ** restartAttempts, RESTART_MAX_DELAY_MS);
            restartAttempts = Math.min(restartAttempts + 1, 10);
            if (restartAttempts > 2 && nav.onLine !== false && state === "listening") setState("reconnecting");
            restartTimer = setTimeout(() => {
                restartTimer = null;
                startListening();
            }, wait);
        }

        // Restart now, forgetting any backoff (tab visible again, back online).
        function kick() {
            if (!shouldListen()) return;
            restartAttempts = 0;
            clearRestartTimer();
            startListening();
        }

        // abort() drops audio in flight; stop() lets Chrome hand over the words
        // it already heard.
        function endRecognition({ immediate }) {
            clearRestartTimer();
            if (!running && !starting) return;
            try {
                if (immediate) recognition.abort();
                else recognition.stop();
            } catch (err) {
                /* already closed */
            }
        }

        function startWatchdog() {
            if (watchdogTimer) return;
            watchdogTimer = setInterval(() => {
                if (!shouldListen()) return;
                const stuck = starting && Date.now() - startRequestedAt > START_STUCK_MS;
                if (stuck) {
                    // start() never reported back -- reset and try again.
                    starting = false;
                    try {
                        recognition.abort();
                    } catch (err) {
                        /* ignore */
                    }
                }
                if (stuck || (!running && !starting && !restartTimer)) scheduleRestart(0);
            }, WATCHDOG_INTERVAL_MS);
        }

        function stopWatchdog() {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }

        // Fires onSpeechPause after the storyteller has been quiet for a moment.
        function schedulePauseCheck() {
            clearTimeout(pauseTimer);
            pauseTimer = setTimeout(() => {
                pauseTimer = null;
                if (lastInterim && running) {
                    // Words still arriving -- wait for them to settle.
                    schedulePauseCheck();
                    return;
                }
                if (!heardSincePause) return;
                heardSincePause = false;
                onSpeechPause();
            }, SPEECH_PAUSE_MS);
        }

        recognition.onstart = () => {
            starting = false;
            running = true;
            restartAttempts = 0;
            reportedError = null;
            setState("listening");
        };

        recognition.onresult = (event) => {
            // Anything heard while a question is read aloud is the
            // interviewer's own voice coming back through the microphone.
            if (suspended || ignoreResults) return;

            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    const text = transcript.trim();
                    if (text) onFinalText(text);
                } else {
                    interim += transcript;
                }
            }
            lastInterim = interim.trim();
            onInterimText(lastInterim);
            if (state !== "listening") setState("listening");
            heardSincePause = true;
            schedulePauseCheck();
        };

        recognition.onerror = (event) => {
            switch (event.error) {
                case "no-speech":
                case "aborted":
                    // Normal: silence, or we stopped it ourselves. onend restarts.
                    return;
                case "network":
                    setState(nav.onLine === false ? "offline" : "reconnecting");
                    return;
                case "audio-capture":
                    // No microphone, or it was unplugged / taken by another app.
                    setState("no-microphone");
                    restartAttempts = Math.max(restartAttempts, 4);
                    return;
                case "not-allowed":
                case "service-not-allowed":
                    wanted = false;
                    stopWatchdog();
                    clearPauseTimer();
                    onInterimText("");
                    setState("blocked");
                    onListeningChange(false);
                    onError(MESSAGES.blocked);
                    return;
                default:
                    // Said once; onend restarts it with backoff, so don't repeat.
                    if (reportedError !== event.error) {
                        reportedError = event.error;
                        onError(`Voice input hiccuped (${event.error}). It will keep trying.`);
                    }
            }
        };

        // Chrome ends the session on its own after a stretch of silence; keep
        // going until the user turns the mic off.
        recognition.onend = () => {
            starting = false;
            running = false;
            // Whatever was still being heard counts as said.
            if (lastInterim && !suspended && !ignoreResults) onFinalText(lastInterim);
            lastInterim = "";
            onInterimText("");
            if (shouldListen()) scheduleRestart();
        };

        // Coming back to the tab, or back online: pick listening straight back
        // up. Going to the background releases the microphone.
        if (doc && doc.addEventListener) {
            doc.addEventListener("visibilitychange", () => {
                if (hidden()) {
                    if (!wanted) return;
                    clearPauseTimer();
                    lastInterim = "";
                    onInterimText("");
                    endRecognition({ immediate: true });
                } else {
                    kick();
                }
            });
        }
        if (win && win.addEventListener) {
            win.addEventListener("online", kick);
            win.addEventListener("offline", () => {
                if (wanted) setState("offline");
            });
        }
        // A headset plugged in or out: Chrome drops recognition on the old device.
        if (nav && nav.mediaDevices && nav.mediaDevices.addEventListener) {
            nav.mediaDevices.addEventListener("devicechange", () => {
                if (!shouldListen()) return;
                endRecognition({ immediate: true });
                scheduleRestart(300);
            });
        }

        // Asks for microphone permission (once), with a friendly message for
        // each way it can fail. The stream is released straight away: speech
        // recognition opens the microphone itself, and holding a second capture
        // open makes recognition flaky on some devices.
        function ensurePermission() {
            if (permissionGranted) return Promise.resolve(true);
            if (permissionRequest) return permissionRequest;
            if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) {
                // Very old browser: let speech recognition ask by itself.
                permissionGranted = true;
                return Promise.resolve(true);
            }
            permissionRequest = nav.mediaDevices
                .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
                .then((stream) => {
                    stream.getTracks().forEach((track) => track.stop());
                    permissionGranted = true;
                    return true;
                })
                .catch((error) => {
                    const name = error && error.name;
                    if (name === "NotFoundError" || name === "OverconstrainedError") {
                        setState("no-microphone");
                        onError(MESSAGES.missing);
                    } else if (name === "NotReadableError" || name === "AbortError") {
                        setState("no-microphone");
                        onError(MESSAGES.busy);
                    } else {
                        setState("blocked");
                        onError(MESSAGES.blocked);
                    }
                    return false;
                })
                .finally(() => {
                    permissionRequest = null;
                });
            return permissionRequest;
        }

        return {
            // True from when the storyteller switches the mic on until they
            // switch it off -- also while it is briefly suspended.
            get listening() {
                return wanted;
            },
            get state() {
                return state;
            },
            get suspended() {
                return suspended;
            },

            // Resolves to whether the mic is now on.
            async start() {
                if (wanted) return true;
                if (!(await ensurePermission())) return false;
                if (wanted) return true; // a second click raced this one
                wanted = true;
                ignoreResults = false;
                restartAttempts = 0;
                startWatchdog();
                onListeningChange(true);
                if (hidden()) setState("idle");
                else startListening();
                return true;
            },

            // discard: abort at once and drop the words not yet handed over.
            // Otherwise Chrome delivers the last words it heard before closing.
            stop({ discard = false } = {}) {
                if (!wanted) return;
                wanted = false;
                if (discard) ignoreResults = true;
                stopWatchdog();
                clearPauseTimer();
                endRecognition({ immediate: discard });
                if (discard) {
                    lastInterim = "";
                    onInterimText("");
                }
                setState("idle");
                onListeningChange(false);
            },

            // While a question is read aloud: stop listening without turning
            // the mic "off", so resume() picks up where the storyteller left it.
            suspend() {
                if (suspended) return;
                suspended = true;
                clearPauseTimer();
                lastInterim = "";
                onInterimText("");
                endRecognition({ immediate: true });
            },

            resume() {
                if (!suspended) return;
                suspended = false;
                kick();
            },
        };
    }

    const api = { createDictation, SPEECH_PAUSE_MS };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof window !== "undefined" ? window : globalThis);
