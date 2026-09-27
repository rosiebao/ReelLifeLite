// The footer switches between <section>s instead of navigating to new URLs, so
// "which page am I on" only ever lives in the DOM. Remember it in a cookie and
// the user comes back to the same page after a refresh -- or after signing back
// in on a later visit.
//
// Restoring is deliberately *not* done on load: restoreLastPage() below is
// called by profile.js only once /whoami has confirmed a real signed-in user,
// so signing in is still a prerequisite for landing on the remembered page.

const LAST_PAGE_COOKIE = "reellife_last_page";
const LAST_PAGE_COOKIE_DAYS = 30;
const DEFAULT_PAGE = "story";

// Footer button id -> the section it shows. Doubles as the list of values the
// cookie is allowed to hold, so a stale or hand-edited one can't point at a
// section that isn't there.
const PAGE_SECTIONS = {
    self: "#selfSection",
    family: "#familySection",
    story: "#tellYourStorySection",
    friends: "#friendsSection",
    community: "#communitySection",
};

$("#storyImageUpload").css("height", $("#storyImageUpload").width + "px");

// ---- Cookie helpers ----

function readCookie(name) {
    const prefix = `${name}=`;
    const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
    if (!entry) return null;
    try {
        return decodeURIComponent(entry.slice(prefix.length));
    } catch (err) {
        return null;
    }
}

function writeCookie(name, value, days) {
    const maxAge = days * 24 * 60 * 60;
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

// ---- Remembering the current page ----

function saveLastPage(pageId) {
    if (!PAGE_SECTIONS[pageId]) return;
    writeCookie(LAST_PAGE_COOKIE, pageId, LAST_PAGE_COOKIE_DAYS);
}

// Falls back to the page the markup starts on when nothing (or something
// unrecognized) is stored.
function readLastPage() {
    const saved = readCookie(LAST_PAGE_COOKIE);
    return saved && PAGE_SECTIONS[saved] ? saved : DEFAULT_PAGE;
}

// ---- Navigation ----

// Slides `pageId` in and everything else out. `animate: false` swaps instantly,
// which is what the restore path wants: no sliding in from a page the user
// never actually looked at. `remember: false` skips the cookie write, so
// restoring doesn't re-save what it just read.
function showPage(pageId, { animate = true, remember = true } = {}) {
    const selector = PAGE_SECTIONS[pageId];
    if (!selector) return;

    const sections = $("main > section");
    const target = $(selector);

    if (remember) saveLastPage(pageId);

    if (!animate) {
        sections.addClass("inactive none").removeClass("active");
        target.addClass("active").removeClass("inactive none");
        return;
    }

    target.removeClass("none");
    setTimeout(() => {
        sections.addClass("inactive");
        sections.removeClass("active");
        target.addClass("active");
        target.removeClass("inactive");
    }, 1);
    setTimeout(() => {
        sections.addClass("none");
        target.removeClass("none");
    }, 801);
}

Object.keys(PAGE_SECTIONS).forEach((pageId) => {
    $(`#${pageId}`).click(() => showPage(pageId));
});

// The header's "Account settings" button opens the same account page the
// footer's "Me" does -- #selfSection is where the account details live.
$("#accountSettingsButton").click(() => showPage("self"));

// ---- Restoring on load ----

// Only worth hiding anything if we're actually going to move the user: a
// signed-out visitor gets bounced to login.html by profile.js, and a saved page
// that's already the active one needs no restore. Everyone else would otherwise
// watch the default page flash past before the swap, so hide main until the
// auth check comes back (see .restoringPage in style.css).
const needsRestore = storageApi.isLoggedIn() && !$(PAGE_SECTIONS[readLastPage()]).hasClass("active");
if (needsRestore) {
    document.body.classList.add("restoringPage");
    // Failsafe: if the auth check never finishes (server down, thrown error),
    // show the page anyway rather than leaving it blank.
    setTimeout(() => document.body.classList.remove("restoringPage"), 5000);
}

// Called by profile.js once the user is known to be signed in.
function restoreLastPage() {
    try {
        showPage(readLastPage(), { animate: false, remember: false });
        // Flush the class changes while .restoringPage still suppresses
        // transitions, so removing it below can't animate the swap.
        void document.body.offsetHeight;
    } finally {
        document.body.classList.remove("restoringPage");
    }
}
