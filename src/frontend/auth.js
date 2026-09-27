// /signup /login /logout /whoami -- mirrors ../database/app/routers/auth.py.
const express = require("express");
const { db } = require("./db");
const { ApiError } = require("./errors");
const { hashPassword, verifyPassword, generateSessionToken, sessionExpiry } = require("./security");

const router = express.Router();

function getBearerToken(req) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
        throw new ApiError(401, "Missing bearer token");
    }
    return header.slice("Bearer ".length).trim();
}

// Attaches req.user ({id, username, email}) or throws a 401 ApiError.
function requireAuth(req, res, next) {
    try {
        const token = getBearerToken(req);
        const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
        if (!session) throw new ApiError(401, "Invalid or expired session");

        if (new Date(session.expires_at).getTime() < Date.now()) {
            db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
            throw new ApiError(401, "Invalid or expired session");
        }

        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
        if (!user) throw new ApiError(401, "Invalid or expired session");

        req.user = { id: user.id, username: user.username, email: user.email };
        next();
    } catch (err) {
        next(err);
    }
}

router.post("/signup", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!username) throw new ApiError(400, "Username cannot be empty");
    if (!email || !email.includes("@")) throw new ApiError(400, "Invalid email address");
    if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");
    if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
        throw new ApiError(409, "Username already taken");
    }
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
        throw new ApiError(409, "Email already registered");
    }

    const info = db
        .prepare("INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(username, email, hashPassword(password), new Date().toISOString());

    res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.post("/login", (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
        throw new ApiError(401, "Invalid email or password");
    }

    // Only one active session per user.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    const token = generateSessionToken();
    db.prepare(
        "INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(user.id, token, new Date().toISOString(), sessionExpiry());

    res.json({ token });
});

router.post("/logout", (req, res) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
        // Gracefully handle logout without token - nothing to logout
        res.json({ ok: true });
        return;
    }
    const token = header.slice("Bearer ".length).trim();
    try {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    } catch (err) {
        // Ignore DB errors on logout
    }
    res.json({ ok: true });
});

router.get("/whoami", requireAuth, (req, res) => {
    res.json(req.user);
});

module.exports = { router, requireAuth };
