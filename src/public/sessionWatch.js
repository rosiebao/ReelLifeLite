// Keeps checking that the person at the keyboard is still signed in as the same
// account the interview was started under.
//
// An interview can run for a long time, hands-free: the microphone is open and
// questions are read aloud. The server rejects every interview call that has no
// valid session (auth.js's requireAuth, plus the per-conversation owner check),
// but a spoken interview mustn't carry on listening after the session is gone,
// so the page also asks. It reports "lost" as soon as any of these happens:
//   * there is no token in this browser any more (signed out in another tab);
//   * /whoami answers 401 (the session expired, or signing in elsewhere
//     replaced it -- the API allows one session per user);
//   * /whoami answers with a different account than when watching began.
// A network failure is NOT treated as lost: a dropped connection shouldn't
// sign anyone out, and the server enforces the session on every call anyway.
//
// Wrapped in a function so tests can load it in Node with fakes.
(function (root) {
    const DEFAULT_INTERVAL_MS = 60 * 1000;

    function browserEnv() {
        return { window: root, document: root.document };
    }

    // options:
    //   check()       -> Promise of the signed-in user ({ id, ... }); rejects with
    //                    an error carrying `status` (401 = session gone).
    //   isSignedIn()  -> whether this browser still holds a token.
    //   tokenKey      -> the localStorage key the token lives in (to notice
    //                    another tab changing it).
    //   onLost(reason) -> called once: 'signed-out' | 'expired' | 'changed'.
    function createSessionWatch(options, env = browserEnv()) {
        const { check, isSignedIn, tokenKey, onLost, intervalMs = DEFAULT_INTERVAL_MS } = options;
        const { window: win, document: doc } = env;

        let timer = null;
        let running = false;
        let lost = false;
        let baselineUserId = null;
        let inFlight = null;

        function lose(reason) {
            if (lost) return false;
            lost = true;
            stop();
            onLost(reason);
            return false;
        }

        // Resolves true while the session looks good, false once it is lost.
        function verify() {
            if (lost) return Promise.resolve(false);
            if (!isSignedIn()) return Promise.resolve(lose("signed-out"));
            if (inFlight) return inFlight;

            inFlight = Promise.resolve()
                .then(check)
                .then((user) => {
                    if (lost) return false;
                    if (user && user.id !== undefined) {
                        if (baselineUserId === null) baselineUserId = user.id;
                        else if (user.id !== baselineUserId) return lose("changed");
                    }
                    return true;
                })
                .catch((err) => {
                    if (err && err.status === 401) return lose("expired");
                    return !lost; // can't tell (offline, server down): keep going
                })
                .finally(() => {
                    inFlight = null;
                });
            return inFlight;
        }

        function onVisible() {
            if (!doc || doc.visibilityState !== "hidden") verify();
        }

        function onOnline() {
            verify();
        }

        // Another tab signed out, or signed in as someone else.
        function onStorage(event) {
            if (event.key === tokenKey || event.key === null) verify();
        }

        function start() {
            if (running) return;
            running = true;
            lost = false;
            baselineUserId = null;
            timer = setInterval(verify, intervalMs);
            if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisible);
            if (win && win.addEventListener) {
                win.addEventListener("online", onOnline);
                win.addEventListener("storage", onStorage);
            }
            verify(); // the baseline: who is signed in right now
        }

        function stop() {
            if (!running) return;
            running = false;
            clearInterval(timer);
            timer = null;
            if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisible);
            if (win && win.removeEventListener) {
                win.removeEventListener("online", onOnline);
                win.removeEventListener("storage", onStorage);
            }
        }

        return {
            start,
            stop,
            verify,
            get lost() {
                return lost;
            },
        };
    }

    const api = { createSessionWatch };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof window !== "undefined" ? window : globalThis);
