// SQLite storage for accounts + conversation history, re-implemented in Node
// (this used to live in ../database as a Python/FastAPI service -- kept there
// unused for reference). Uses node:sqlite (built-in, no native dependency to
// compile) rather than a third-party driver.
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "app.db");

const db = new DatabaseSync(DB_PATH);
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

// A "Tell Your Story" conversation is an interview (see ../interview.js):
// interview_mode picks the interviewer's angle, and opening_question is the
// interviewer's first question -- the one turn that isn't the response to a
// prompt, because it comes before the user has said anything. Both arrived
// after the table did, so an existing app.db gets them added.
const conversationColumns = db.prepare("PRAGMA table_info(conversation)").all();
if (!conversationColumns.some((column) => column.name === "interview_mode")) {
    db.exec("ALTER TABLE conversation ADD COLUMN interview_mode TEXT");
}
if (!conversationColumns.some((column) => column.name === "opening_question")) {
    db.exec("ALTER TABLE conversation ADD COLUMN opening_question TEXT");
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

// Every story "Write my story" has produced, kept so the History tab can bring
// one back after the publish dialog that showed it was closed. A draft is
// never edited: editing happens in the publish dialog, and publishing copies
// the result into `stories`. Drafts go with their conversation.
db.exec(`
    CREATE TABLE IF NOT EXISTS story_drafts (
        draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversation(conversation_id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
`);
db.exec("CREATE INDEX IF NOT EXISTS story_drafts_user ON story_drafts (user_id, created_at)");

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

module.exports = { db, DB_PATH };
