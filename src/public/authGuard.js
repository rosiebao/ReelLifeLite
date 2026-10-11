// Loaded in index.html's <head>, before any of the page renders, so a
// signed-out visitor is sent to login.html without the main page flashing past
// first. profile.js still checks the token with the server once the page loads
// (it may have expired); this only catches the "no token at all" case early.
(function () {
    function leaveIfSignedOut() {
        if (!storageApi.isLoggedIn()) {
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
