const usernameField = document.querySelector("#usernameField");
const usernameInput = document.querySelector("#username");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const passwordHint = document.querySelector("#passwordHint");
const errorMessage = document.querySelector("#errorMessage");
const signInButton = document.querySelector("#signInButton");
const toggleModeLink = document.querySelector("#toggleMode");
const formTitle = document.querySelector("#formTitle");

let mode = "login";
let submitting = false;

function setError(message) {
    errorMessage.textContent = message || "";
}

async function handleSubmit() {
    if (submitting) return;
    submitting = true;
    setError("");
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    try {
        if (mode === "signup") {
            const username = usernameInput.value.trim();
            await storageApi.signup({ username, email, password });
        }
        await storageApi.login({ email, password });
        window.location.href = "index.html";
    } catch (err) {
        if (err instanceof ApiError) {
            setError(err.detail);
        } else {
            setError("Could not reach the server. Is the API running?");
        }
        submitting = false;
    }
}

signInButton.addEventListener("click", handleSubmit);

// There's no <form> here, so Enter has to be wired up by hand: from any of the
// fields, and from the Sign In button itself once it's focused.
for (const input of [usernameInput, emailInput, passwordInput]) {
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            handleSubmit();
        }
    });
}

signInButton.addEventListener("keydown", (event) => {
    // Space is what a real <button> responds to as well.
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSubmit();
    }
});

toggleModeLink.addEventListener("click", (event) => {
    event.preventDefault();
    mode = mode === "login" ? "signup" : "login";
    usernameField.classList.toggle("hidden", mode !== "signup");
    passwordHint.classList.toggle("hidden", mode !== "signup");
    formTitle.textContent = mode === "signup" ? "Sign Up" : "Login";
    signInButton.textContent = mode === "signup" ? "Sign Up" : "Sign In";
    toggleModeLink.textContent =
        mode === "signup" ? "LOG IN" : "SIGN UP";
    setError("");
});
