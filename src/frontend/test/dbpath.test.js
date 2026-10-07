// Tests for where db.js puts the SQLite file (the DATABASE_PATH environment
// variable). Run with: npm test
//
// node --test runs each test file in its own process. DATABASE_PATH is set
// below before db.js is loaded, so this file opens a database in a folder that
// doesn't exist yet -- which also checks that the folder gets created.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-dbpath-"));
const nestedDbPath = path.join(scratch, "not", "created", "yet", "app.db");
process.env.DATABASE_PATH = nestedDbPath;
process.env.MEDIA_ROOT = path.join(scratch, "media");

const { db, DB_PATH, DEFAULT_DB_PATH, resolveDatabasePath } = require("../db");

test.after(() => {
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
});

test("unset or blank DATABASE_PATH uses src/frontend/app.db", () => {
    assert.equal(DEFAULT_DB_PATH, path.join(__dirname, "..", "app.db"));
    assert.equal(resolveDatabasePath({}, "/anywhere"), DEFAULT_DB_PATH);
    assert.equal(resolveDatabasePath({ DATABASE_PATH: "" }, "/anywhere"), DEFAULT_DB_PATH);
    assert.equal(resolveDatabasePath({ DATABASE_PATH: "   " }, "/anywhere"), DEFAULT_DB_PATH);
});

test("an absolute DATABASE_PATH is used as is", () => {
    const absolute = path.join(os.tmpdir(), "reellife", "app.db");
    assert.equal(resolveDatabasePath({ DATABASE_PATH: absolute }, "/somewhere/else"), absolute);
});

test("a relative DATABASE_PATH is resolved against the working directory", () => {
    const cwd = path.join(os.tmpdir(), "project");
    assert.equal(resolveDatabasePath({ DATABASE_PATH: "data/app.db" }, cwd), path.join(cwd, "data", "app.db"));
    assert.equal(resolveDatabasePath({ DATABASE_PATH: "./app.db" }, cwd), path.join(cwd, "app.db"));
});

test("surrounding spaces are ignored", () => {
    const absolute = path.join(os.tmpdir(), "spaced.db");
    assert.equal(resolveDatabasePath({ DATABASE_PATH: `  ${absolute}  ` }, "/x"), absolute);
});

test("a DATABASE_PATH that is a directory gets app.db inside it", () => {
    // An existing folder, e.g. a mounted disk like DATABASE_PATH=/data on Render.
    const dir = fs.mkdtempSync(path.join(scratch, "mount-"));
    assert.equal(resolveDatabasePath({ DATABASE_PATH: dir }, "/x"), path.join(dir, "app.db"));
    // A trailing slash marks a folder even if it doesn't exist yet.
    const missing = path.join(scratch, "future-dir");
    assert.equal(resolveDatabasePath({ DATABASE_PATH: missing + "/" }, "/x"), path.join(missing, "app.db"));
    assert.equal(resolveDatabasePath({ DATABASE_PATH: "data/" }, cwdFor("p")), path.join(cwdFor("p"), "data", "app.db"));
});

test("a directory DATABASE_PATH opens app.db inside it", () => {
    const dir = fs.mkdtempSync(path.join(scratch, "mounted-"));
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('./db').DB_PATH)"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATABASE_PATH: dir },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, path.join(dir, "app.db"));
    assert.ok(fs.existsSync(path.join(dir, "app.db")), "app.db created inside the folder");
});

function cwdFor(name) {
    return path.join(os.tmpdir(), name);
}

test(":memory: is passed through for a throwaway database", () => {
    assert.equal(resolveDatabasePath({ DATABASE_PATH: ":memory:" }, "/x"), ":memory:");
});

test("the database is opened at DATABASE_PATH, creating missing folders", () => {
    assert.equal(DB_PATH, nestedDbPath);
    assert.ok(fs.existsSync(nestedDbPath), "database file was created at DATABASE_PATH");
    assert.ok(!fs.existsSync(path.join(scratch, "app.db")), "nothing written anywhere else");

    // The schema was created in that file.
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
    for (const table of ["users", "sessions", "conversation", "prompts", "stories", "friendships"]) {
        assert.ok(tables.includes(table), `table ${table} exists`);
    }
});

test("data written goes to that file and is still there when reopened", () => {
    db.prepare(
        "INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
    ).run("pathcheck", "pathcheck@example.com", "x", new Date().toISOString());

    const { DatabaseSync } = require("node:sqlite");
    const reopened = new DatabaseSync(nestedDbPath);
    try {
        const row = reopened.prepare("SELECT username FROM users WHERE email = ?").get("pathcheck@example.com");
        assert.equal(row.username, "pathcheck");
    } finally {
        reopened.close();
    }
});

test("a DATABASE_PATH that can't be opened fails loudly, naming the path", () => {
    // A regular file where a folder is needed: the folder can't be created.
    const blocker = path.join(scratch, "blocker");
    fs.writeFileSync(blocker, "not a folder");
    const impossible = path.join(blocker, "app.db");

    const result = spawnSync(process.execPath, ["-e", "require('./db')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATABASE_PATH: impossible },
        encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "process exits with an error");
    assert.match(result.stderr, /blocker/, "error mentions the bad path");
});

test("DATABASE_PATH=:memory: writes nothing to disk", () => {
    const cwd = fs.mkdtempSync(path.join(scratch, "memory-"));
    const script = [
        "const { db, DB_PATH } = require(" + JSON.stringify(path.join(__dirname, "..", "db.js")) + ");",
        "db.prepare(\"INSERT INTO users (username, email, password_hash, created_at) VALUES ('m', 'm@x', 'x', 'now')\").run();",
        "process.stdout.write(DB_PATH + '|' + db.prepare('SELECT COUNT(*) AS n FROM users').get().n);",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
        cwd,
        env: { ...process.env, DATABASE_PATH: ":memory:" },
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ":memory:|1");
    assert.deepEqual(fs.readdirSync(cwd), [], "no file created in the working directory");
});
