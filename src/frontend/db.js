// SQLite storage for accounts + conversation history, re-implemented in Node
// (this used to live in ../database as a Python/FastAPI service -- kept there
// unused for reference). Uses node:sqlite (built-in, no native dependency to
// compile) rather than a third-party driver.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Where the SQLite file lives, from the DATABASE_PATH environment variable.
//   unset / blank   -> src/frontend/app.db (next to this file), as before
//   absolute path   -> used as is
//   relative path   -> resolved against the directory the process started in
//   ":memory:"      -> a throwaway in-memory database (nothing written to disk)
//   a directory     -> app.db inside it. Applies to an existing directory or a
//                      path ending in "/", e.g. DATABASE_PATH=/data where /data
//                      is a mounted disk (Render, Docker volumes).
// Kept separate from opening the file so it can be tested on its own.
const DB_FILE_NAME = "app.db";
const DEFAULT_DB_PATH = path.join(__dirname, DB_FILE_NAME);

function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function resolveDatabasePath(env = process.env, cwd = process.cwd()) {
    const raw = typeof env.DATABASE_PATH === "string" ? env.DATABASE_PATH.trim() : "";
    if (!raw) return DEFAULT_DB_PATH;
    if (raw === ":memory:") return raw;
    const resolved = path.resolve(cwd, raw);
    if (/[\\/]$/.test(raw) || isDirectory(resolved)) {
        return path.join(resolved, DB_FILE_NAME);
    }
    return resolved;
}

function openDatabase(dbPath) {
    if (dbPath !== ":memory:") {
        // A fresh location (e.g. a mounted volume or data/ folder) may not
        // exist yet; SQLite won't create the folder itself.
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    try {
        return new DatabaseSync(dbPath);
    } catch (err) {
        throw new Error(
            `Could not open the database at ${dbPath} (from DATABASE_PATH=${JSON.stringify(
                process.env.DATABASE_PATH ?? ""
            )}): ${err.message}`
        );
    }
}

const DB_PATH = resolveDatabasePath();

const db = openDatabase(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS conversation (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        conversation TEXT,
        creation_date TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0
    )
`);

// What a conversation is. 'chat' is the Story tab's typed conversation;
// 'interview' is a recorded Claude interview (public/interview.html), which also
// keeps what it takes to resume it -- the interview mode (which system prompt
// the interviewer uses) and the answer method -- plus a per-user running number,
// so the Story tab can list it as "Interview #3" and the number never shifts.
// Added after the table existed, so existing app.db files get the columns here
// (existing rows are chats: NULL number/mode/method).
const conversationColumns = db.prepare("PRAGMA table_info(conversation)").all();
const conversationColumnAdditions = [
    ["kind", "TEXT NOT NULL DEFAULT 'chat'"],
    ["interview_number", "INTEGER"],
    ["interview_mode", "TEXT"],
    ["interview_method", "TEXT"],
];
for (const [name, definition] of conversationColumnAdditions) {
    if (!conversationColumns.some((column) => column.name === name)) {
        db.exec(`ALTER TABLE conversation ADD COLUMN ${name} ${definition}`);
    }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
        prompt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversation(conversation_id),
        prompt_time TEXT NOT NULL,
        content TEXT NOT NULL,
        response TEXT,
        input_media TEXT,
        output_media TEXT
    )
`);

// The Family tab's tree, one set of rows per user. Kept normalized (rather
// than one JSON blob per user) so per-member data -- a story, a real photo --
// can hang off family_members later.
db.exec(`
    CREATE TABLE IF NOT EXISTS family_rows (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS family_members (
        member_id INTEGER PRIMARY KEY AUTOINCREMENT,
        row_id INTEGER NOT NULL REFERENCES family_rows(row_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        photo TEXT,
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )
`);

// is_self marks the account holder's own node ("Me"). It arrived after the
// table did, so an existing app.db needs the column added rather than a
// CREATE TABLE that SQLite will skip.
const familyMemberColumns = db.prepare("PRAGMA table_info(family_members)").all();
if (!familyMemberColumns.some((column) => column.name === "is_self")) {
    db.exec("ALTER TABLE family_members ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0");

    // One-time: trees saved before the column existed have their "Me" node
    // picked out by name -- the only clue available after the fact.
    db.exec(`
        UPDATE family_members SET is_self = 1 WHERE member_id IN (
            SELECT MIN(m.member_id)
            FROM family_members m
            JOIN family_rows r ON r.row_id = m.row_id
            WHERE m.name = 'Me'
            GROUP BY r.user_id
        )
    `);
}

// Records that a user's tree has been set up, so the starting layout is only
// ever applied to a genuinely new account. Without this, a user who deletes
// every row looks identical to one who has never opened the tab, and the
// default tree would come back and overwrite the deletion.
db.exec(`
    CREATE TABLE IF NOT EXISTS family_state (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        seeded_at TEXT NOT NULL
    )
`);

// Anyone who already had a tree before family_state existed counts as seeded.
db.exec(`
    INSERT OR IGNORE INTO family_state (user_id, seeded_at)
    SELECT DISTINCT user_id, created_at FROM family_rows
`);

// Published stories. A story is a snapshot of a "Tell Your Story" conversation
// -- its text is copied into `content` at publish time rather than read back
// out of the transcript file, so editing the conversation afterwards doesn't
// silently rewrite what other people already saw. Re-publishing the same
// conversation updates its story (see the unique index below) instead of
// piling up duplicates in everyone's feed.
//
// visibility drives the Friends and Community tabs:
//   'private'  -- only the author sees it
//   'friends'  -- the author and their accepted friends (Friends tab)
//   'public'   -- everyone (Friends tab for friends, Community tab for all)
db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
        story_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversation(conversation_id),
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        place TEXT NOT NULL DEFAULT '',
        time_period TEXT NOT NULL DEFAULT '',
        photo TEXT NOT NULL DEFAULT 'profile.jpg',
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
`);

// One story per conversation, so publishing twice edits the existing story.
// Partial index: stories detached from a conversation don't collide on NULL.
db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS stories_conversation_unique
    ON stories (conversation_id) WHERE conversation_id IS NOT NULL
`);

// The feed queries filter by visibility and then by author, so lead with it.
db.exec("CREATE INDEX IF NOT EXISTS stories_visibility ON stories (visibility, user_id)");

// Friend graph. One row per request, in the direction it was sent; a
// friendship is that row once status flips to 'accepted', which is why every
// "are these two friends" check has to look at both directions. Declining
// deletes the row rather than storing a 'declined' state -- it keeps the
// uniqueness rule simple and lets the pair try again later.
db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
        friendship_id INTEGER PRIMARY KEY AUTOINCREMENT,
        requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        responded_at TEXT,
        UNIQUE (requester_id, addressee_id),
        CHECK (requester_id <> addressee_id)
    )
`);

// Incoming requests ("who wants to be my friend") are looked up by addressee,
// which the UNIQUE(requester_id, addressee_id) index above can't serve.
db.exec("CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee_id, status)");

module.exports = { db, DB_PATH, DEFAULT_DB_PATH, resolveDatabasePath };
