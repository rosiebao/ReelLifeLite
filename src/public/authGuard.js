// Loaded in index.html's <head>, before any of the page renders, so a
// signed-out visitor is sent to login.html without the main page flashing past
// first. profile.js still checks the token with the server once the page loads
// (it may have expired); this only catches the "no token at all" case early.
(function () {
    // A family invitation link (index.html?invite=...) opened while signed
    // out: keep the token for this tab, so family.js can offer it once the
    // visitor has signed in or made an account.
    function keepInviteToken() {
        try {
            const token = new URLSearchParams(window.location.search).get("invite");
            if (token) sessionStorage.setItem("reellife_pending_invite", token);
        } catch (err) {
            // Storage blocked: the invitation just has to be opened again.
        }
    }

    function leaveIfSignedOut() {
        if (!storageApi.isLoggedIn()) {
            keepInviteToken();
            // replace(), not href, so the main page isn't left in history for
            // the back arrow to return to.
            window.location.replace("login.html");
        }
    }

    leaveIfSignedOut();

    // The back/forward arrows can restore this page from the browser's
    // back-forward cache, which brings it back exactly as it was left -- none
    // of the scripts run again, so the check above wouldn't either. pageshow
    // still fires, with `persisted` set for a cache restore.
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) leaveIfSignedOut();
    });
})();
