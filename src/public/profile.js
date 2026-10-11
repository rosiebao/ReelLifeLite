// Waits for logout() so the token is really gone before the page unloads, and
// uses replace() so the back arrow can't return to this page afterwards.
async function goToLogin() {
    await storageApi.logout();
    window.location.replace("login.html");
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
        goToLogin();
    }
})();

// The only way out is the button in the header's nav bar.
document.querySelector("#headerLogoutButton").addEventListener("click", goToLogin);
