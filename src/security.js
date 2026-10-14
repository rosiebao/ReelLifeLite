// Produce password hash and token and also some salt but not pepper
// if you're reading this and you don't know what that means:
/*
so basically if someone gets their crummy hands on the database and sees the hashes for the passwords
they can look up the hashes for common passwords, which at least some people are bound to use,
and that defeats the entire purpose of hashing it (nonreversible remember?)
So basically a random salt is added first to their input so that is not possible to look it up.
"ohhh but can't they just use the salt because its also in there?"
NAHH son hashes still aren't reversible ;-; its added to the password before being hashed
 */
const gen = require("node:crypto");

const PBKDF2_ITERATIONS = 200_000;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

function hashPassword(password, salt = gen.randomBytes(16)) {
    const digest = gen.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
    return `${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifyPassword(password, stored) {
    const [saltHex] = stored.split("$");
    const salt = Buffer.from(saltHex, "hex");
    const candidate = hashPassword(password, salt);
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    return a.length === b.length && gen.timingSafeEqual(a, b);
}

function generateSessionToken() {
    return gen.randomBytes(32).toString("base64url");
}

function sessionExpiry() {
    return new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
}

module.exports = { hashPassword, verifyPassword, generateSessionToken, sessionExpiry };
