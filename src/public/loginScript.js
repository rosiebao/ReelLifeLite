const usernameField = document.querySelector("#usernameField");
const usernameInput = document.querySelector("#username");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const passwordHint = document.querySelector("#passwordHint");
const errorMessage = document.querySelector("#errorMessage");
const signInButton = document.querySelector("#signInButton");
const toggleModeLink = document.querySelector("#toggleMode");
const formTitle = document.querySelector("#formTitle");
const formSubtitle = document.querySelector("#formSubtitle");
const switchPrompt = document.querySelector("#switchPrompt");
const authForm = document.querySelector("#authForm");
const togglePasswordButton = document.querySelector("#togglePassword");

// Everything on the page that reads differently between the two modes.
const MODE_TEXT = {
    login: {
        title: "Welcome back",
        subtitle: "Sign in to continue your ReelLife journey.",
        button: "Sign in",
        prompt: "Don't have an account?",
        link: "Create an account",
        passwordAutocomplete: "current-password",
    },
    signup: {
        title: "Create your account",
        subtitle: "Join ReelLife and start sharing your story.",
        button: "Create account",
        prompt: "Already have an account?",
        link: "Sign in",
        passwordAutocomplete: "new-password",
    },
};

let mode = "login";
let submitting = false;

function setError(message) {
    errorMessage.textContent = message || "";
}

async function handleSubmit() {
    if (submitting) return;
    submitting = true;
    signInButton.disabled = true;
    setError("");
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    try {
        if (mode === "signup") {
            const username = usernameInput.value.trim();
            await storageApi.signup({ username, email, password });
        }
        await storageApi.login({ email, password });
        // replace() so the back arrow from the main page doesn't land back here.
        window.location.replace("index.html");
    } catch (err) {
        if (err instanceof ApiError) {
            setError(err.detail);
        } else {
            setError("Could not reach the server. Is the API running?");
        }
        submitting = false;
        signInButton.disabled = false;
    }
}

// A real <form>: Enter in any field and clicking/activating the button all
// arrive here as one submit event. novalidate on the form leaves the error
// messages to the server, which already words them for the user.
authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSubmit();
});

togglePasswordButton.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    togglePasswordButton.setAttribute("aria-pressed", String(show));
    togglePasswordButton.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

function applyMode() {
    const text = MODE_TEXT[mode];
    usernameField.classList.toggle("hidden", mode !== "signup");
    passwordHint.classList.toggle("hidden", mode !== "signup");
    formTitle.textContent = text.title;
    formSubtitle.textContent = text.subtitle;
    signInButton.textContent = text.button;
    switchPrompt.textContent = text.prompt;
    toggleModeLink.textContent = text.link;
    passwordInput.autocomplete = text.passwordAutocomplete;
    setError("");
}

toggleModeLink.addEventListener("click", (event) => {
    event.preventDefault();
    mode = mode === "login" ? "signup" : "login";
    applyMode();
    (mode === "signup" ? usernameInput : emailInput).focus();
});
