// Password hashing + session tokens, using only Node's built-in crypto module.
//
// The hash format ("<saltHex>$<digestHex>", PBKDF2-HMAC-SHA256, 200k
// iterations, 32-byte output) is identical to the Python implementation in
// ../database/app/security.py, so a password hash produced by either backend
// verifies correctly against the other.
const crypto = require("node:crypto");

const PBKDF2_ITERATIONS = 200_000;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
    const digest = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
    return `${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifyPassword(password, stored) {
    const [saltHex] = stored.split("$");
    const salt = Buffer.from(saltHex, "hex");
    const candidate = hashPassword(password, salt);
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString("base64url");
}

function sessionExpiry() {
    return new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
}

module.exports = { hashPassword, verifyPassword, generateSessionToken, sessionExpiry };
