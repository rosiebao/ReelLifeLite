// The profile page (#selfSection): who you are and the details you can edit.
// Also the session gate for index.html -- nothing
// else on the page is shown until whoami() confirms the login.
//
// Values typed by the user only ever go in through .value/.textContent.

const profileState = {
    // The profile as last saved, so Cancel can put the form back.
    saved: null,
};

const profileEls = {
    picture: document.querySelector("#profilePicture"),
    photoInput: document.querySelector("#profilePhotoInput"),
    photoError: document.querySelector("#photoError"),
    displayName: document.querySelector("#profileDisplayName"),
    handle: document.querySelector("#profileHandle"),
    tagline: document.querySelector("#profileTagline"),
    memberSince: document.querySelector("#memberSince"),
    memberSinceText: document.querySelector("#memberSinceText"),
    form: document.querySelector("#profileForm"),
    firstName: document.querySelector("#profileFirstName"),
    lastName: document.querySelector("#profileLastName"),
    username: document.querySelector("#profileUsername"),
    email: document.querySelector("#profileEmail"),
    location: document.querySelector("#profileLocation"),
    bio: document.querySelector("#profileBio"),
    formError: document.querySelector("#profileFormError"),
    saved: document.querySelector("#profileSaved"),
    saveBtn: document.querySelector("#profileSaveBtn"),
    cancelBtn: document.querySelector("#profileCancelBtn"),
};

const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const DEFAULT_TAGLINE = "Collecting memories, one story at a time.";

function profileErrorText(err) {
    return err?.detail || err?.message || "Something went wrong";
}

function setProfileError(element, message) {
    element.textContent = message || "";
    element.classList.toggle("hidden", !message);
}

// Waits for logout() so the token is really gone before the page unloads, and
// uses replace() so the back arrow can't return to this page afterwards.
async function goToLogin() {
    await storageApi.logout();
    window.location.replace("login.html");
}

// The round Profile button in the header: your photo once you have one,
// otherwise the outline person icon.
const headerAvatar = document.querySelector("#self");
const headerAvatarImg = headerAvatar.querySelector("img");
const DEFAULT_HEADER_ICON = "Me Icon.svg";

function renderHeaderAvatar(photoUrl) {
    headerAvatar.classList.toggle("hasPhoto", Boolean(photoUrl));
    headerAvatarImg.src = photoUrl || DEFAULT_HEADER_ICON;
}

// If the photo file can't be loaded (deleted, offline), fall back to the icon
// rather than showing a broken image in the header.
headerAvatarImg.addEventListener("error", () => {
    if (headerAvatar.classList.contains("hasPhoto")) renderHeaderAvatar(null);
});

// The card at the top: what other people see.
function renderProfileIdentity(profile) {
    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
    profileEls.displayName.textContent = fullName || profile.username;
    profileEls.handle.textContent = `@${profile.username}`;
    profileEls.tagline.textContent = profile.bio || DEFAULT_TAGLINE;
    profileEls.tagline.classList.toggle("placeholder", !profile.bio);
    profileEls.picture.src = profile.photo_url || "profile.jpg";
    renderHeaderAvatar(profile.photo_url);

    const joined = profile.created_at ? new Date(profile.created_at) : null;
    if (joined && !Number.isNaN(joined.getTime())) {
        profileEls.memberSinceText.textContent = `Member since ${joined.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
        })}`;
        profileEls.memberSince.classList.remove("hidden");
    }
}

function fillProfileForm(profile) {
    profileEls.firstName.value = profile.first_name;
    profileEls.lastName.value = profile.last_name;
    profileEls.username.value = profile.username;
    profileEls.email.value = profile.email;
    profileEls.location.value = profile.location;
    profileEls.bio.value = profile.bio;
}

function applyProfile(profile) {
    profileState.saved = profile;
    renderProfileIdentity(profile);
    fillProfileForm(profile);
}

// ---- Personal details ----

let savedTimer = null;
function flashSaved() {
    profileEls.saved.classList.remove("hidden");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => profileEls.saved.classList.add("hidden"), 2500);
}

profileEls.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setProfileError(profileEls.formError, "");

    const username = profileEls.username.value.trim();
    const email = profileEls.email.value.trim();
    if (!username) return setProfileError(profileEls.formError, "Username cannot be empty.");
    if (!email.includes("@")) return setProfileError(profileEls.formError, "Please enter a valid email address.");

    profileEls.saveBtn.disabled = true;
    try {
        const profile = await storageApi.updateProfile({
            first_name: profileEls.firstName.value,
            last_name: profileEls.lastName.value,
            username,
            email,
            location: profileEls.location.value,
            bio: profileEls.bio.value,
        });
        applyProfile(profile);
        flashSaved();
    } catch (err) {
        setProfileError(profileEls.formError, profileErrorText(err));
    } finally {
        profileEls.saveBtn.disabled = false;
    }
});

profileEls.cancelBtn.addEventListener("click", () => {
    if (profileState.saved) fillProfileForm(profileState.saved);
    setProfileError(profileEls.formError, "");
});

// ---- Photo ----

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

profileEls.photoInput.addEventListener("change", async () => {
    const file = profileEls.photoInput.files[0];
    // Cleared so picking the same file again still fires "change".
    profileEls.photoInput.value = "";
    if (!file) return;
    setProfileError(profileEls.photoError, "");

    if (!["image/jpeg", "image/png"].includes(file.type)) {
        return setProfileError(profileEls.photoError, "Please choose a JPG or PNG.");
    }
    if (file.size > MAX_PROFILE_PHOTO_BYTES) {
        return setProfileError(profileEls.photoError, "That photo is over 5 MB.");
    }

    try {
        const dataUrl = await readAsDataUrl(file);
        const profile = await storageApi.uploadProfilePhoto({
            filename: file.name,
            dataBase64: String(dataUrl).split(",")[1],
        });
        profileState.saved = { ...profileState.saved, photo_url: profile.photo_url };
        renderProfileIdentity(profileState.saved);
    } catch (err) {
        setProfileError(profileEls.photoError, profileErrorText(err));
    }
});

// ---- Loading ----

(async function loadProfile() {
    if (!storageApi.isLoggedIn()) {
        goToLogin();
        return;
    }

    let user;
    try {
        user = await storageApi.whoami();
    } catch (err) {
        goToLogin();
        return;
    }

    // Now -- and only now -- that the session is confirmed, drop the user
    // back on the page they left off on. restoreLastPage() lives in
    // script.js, which index.html loads before this file.
    restoreLastPage();

    try {
        applyProfile(await storageApi.getProfile());
    } catch (err) {
        // The login is fine, so show what whoami() gave rather than nothing.
        applyProfile({
            ...user,
            first_name: "",
            last_name: "",
            location: "",
            bio: "",
            photo_url: null,
            created_at: null,
        });
    }
})();

// The only way out is the button in the header's nav bar.
document.querySelector("#headerLogoutButton").addEventListener("click", goToLogin);
