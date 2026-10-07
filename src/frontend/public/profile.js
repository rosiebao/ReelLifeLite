function goToLogin() {
    window.location.href = "login.html";
}

// Revoke the session (server + local token) before leaving the page, so the
// login page -- and anything loaded after it -- sees the user as signed out.
let loggingOut = false;
async function logOut() {
    if (loggingOut) return;
    loggingOut = true;
    await storageApi.logout();
    goToLogin();
}

(async function loadProfile() {
    if (!storageApi.isLoggedIn()) {
        goToLogin();
        return;
    }

    try {
        const user = await storageApi.whoami();
        document.querySelector("#username").innerText = user.username;
        document.querySelector("#email").innerText = user.email;
        // The accounts API doesn't track a phone number, so #phone is left at
        // its static placeholder text.

        // Now -- and only now -- that the session is confirmed, drop the user
        // back on the page they left off on. restoreLastPage() lives in
        // script.js, which index.html loads before this file.
        restoreLastPage();
    } catch (err) {
        // A 401 already cleared the token; anything else (server down, etc.)
        // still means we can't confirm the session, so sign out cleanly.
        await logOut();
    }
})();

// Two ways out: the button in the header and the one on the account page.
// Looked up defensively: a missing button must not stop the other one (or the
// rest of this script) from working.
for (const selector of ["#logoutButton", "#headerLogoutButton"]) {
    document.querySelector(selector)?.addEventListener("click", logOut);
}
