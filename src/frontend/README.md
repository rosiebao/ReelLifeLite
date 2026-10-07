# ReelLife frontend + API

One Express process serves the static UI (`public/`) and the accounts/
conversation-history API. This used to be two services -- this Express app
plus a separate Python/FastAPI service in `../database` -- converged into one
so there's only one process to run. The API here is a from-scratch Node
re-implementation of `../database`'s API (kept there, unused, for reference),
not a port of its code.

Kept the same on purpose:

- table/column layout (`users`, `sessions`, `conversation`, `prompts`)
- password hashing format (PBKDF2-HMAC-SHA256, 200k iterations,
  `<saltHex>$<digestHex>`) -- a hash produced by either backend verifies
  against the other
- "one active session per user" login model (opaque bearer token stored
  server-side, not a JWT)

## Stack

- **express** -- HTTP server, both static files and the API
- **node:sqlite** (built-in, no native dependency to install/compile) --
  storage. It's still an experimental Node API, so `npm start`/`npm test`
  print an `ExperimentalWarning`; that's expected. Requires Node >= 22.5.
- **node:crypto** -- password hashing + session tokens
- **node:test** (built-in) -- the test suite, no test framework dependency

## Project layout

```
app.js            Express app: JSON body parsing, static files, the two
                   routers below, error-handling middleware
auth.js           /signup /login /logout /whoami + the requireAuth middleware
conversations.js  /conversations, /prompts
friends.js        /friends, /users/search -- the friend graph
stories.js        /stories -- publishing a conversation for others to read
db.js             node:sqlite connection + schema (CREATE TABLE IF NOT EXISTS)
security.js       password hashing + session token helpers
storage.js        transcript/media file helpers
errors.js         ApiError(status, message)
test/             node --test suite (auth, conversations, family, friends,
                   stories)
public/           static frontend (see below)
```

Large content -- the running conversation transcript and any attached media
-- is written to files under `MEDIA_ROOT` (default `conversation_files/`),
with only the file path stored in the database. See `storage.js`.

## Setup

```bash
cd frontend
npm install
npm start
```

Runs on http://localhost:6767 by default (`PORT` env var to change it).
Tables are created automatically on startup -- no migration step.

### Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `6767` | Port the Express app listens on |
| `DATABASE_PATH` | `src/frontend/app.db` | SQLite file path (see below) |
| `MEDIA_ROOT` | `./conversation_files` | Where transcripts/media attachments are written |

`DATABASE_PATH` (read in `db.js`):

- **Unset or blank:** `app.db` next to `db.js` (`src/frontend/app.db`), the
  same file as before, wherever the server is started from.
- **Absolute path:** used as is, e.g. `/var/lib/reellife/app.db` on a server
  or a mounted volume in a container.
- **Relative path:** resolved against the directory the process starts in.
  `start-dev.sh` resolves it against the directory you run the script from,
  before it changes into `src/server`.
- **`:memory:`:** a throwaway in-memory database. Nothing is written to disk,
  and everything is lost when the server stops.

A missing parent folder is created on startup. If the file can't be opened,
the server stops with an error that names the path, rather than starting
without a database. The server prints the database path it's using when it
starts.

```bash
# A database outside the repo
DATABASE_PATH=/var/lib/reellife/app.db ./start-dev.sh

# Separate demo data, under ./data (relative to where you run this)
DATABASE_PATH=data/demo.db ./start-dev.sh
```

Point `DATABASE_PATH` at a location outside the repo for real data. The default
`src/frontend/app.db` is git-ignored, but any other path inside the repo is
not, so add it to `.gitignore` if you keep one there.

## Running the tests

```bash
cd frontend
npm test
```

`node --test` runs each test file in its own process, so `test/auth.test.js`
and `test/conversations.test.js` each get a fresh throwaway SQLite file and
media directory (set via `DATABASE_PATH`/`MEDIA_ROOT` at the top of the file,
before `../app` is required) -- nothing touches the real `app.db` or
`conversation_files/`.

## API

All endpoints below (except `/signup`, `/login`) require
`Authorization: Bearer <token>` from `/login`.

- `POST /signup` -- `{"username", "email", "password"}` -> `201 {"id": ...}`
- `POST /login` -- `{"email", "password"}` -> `200 {"token": ...}` (invalidates
  any previous session for that user)
- `POST /logout` -- revokes the current session token -> `200 {"ok": true}`
- `GET /whoami` -> `200 {"id", "username", "email"}`
- `POST /conversations` -> `201 {"conversation_id": ...}`
- `GET /conversations` -- list the caller's conversations
- `GET /conversations/{id}` -- a single conversation (404 if it isn't yours)
- `GET /conversations/{id}/prompts` -- that conversation's prompts, oldest first
- `POST /conversations/{id}/prompts` -- `{"content", "input_media_filename"?,
  "input_media_base64"?}` -> `201 {"prompt_id": ...}`
- `POST /prompts/{id}/response` -- `{"response", "output_media_filename"?,
  "output_media_base64"?, "cost"?}` -> `200 {"ok": true}` (adds `cost` to the
  conversation's running total)

### Stories

A story is a published snapshot of a conversation: its text is copied into
`stories.content` when it's published, so later messages don't rewrite what
people have already read, and the conversation it came from is left alone.
`visibility` is `private` (author only), `friends` (author + accepted
friends, the Friends tab) or `public` (everyone, the Community tab).

- `POST /stories` -- `{"conversation_id", "title", "summary"?, "content"?,
  "tags"?, "place"?, "time_period"?, "photo"?, "visibility"?}` ->
  `201` with the story. `content` defaults to the author's own messages in
  that conversation (the assistant's replies are interview prompts, not the
  story). Publishing the same conversation again edits its story and returns
  `200` -- there's one story per conversation.
- `GET /stories/mine` -- the caller's own stories, newest first
- `GET /stories/friends` -- friends' stories with visibility `friends` or
  `public` (not the caller's own)
- `GET /stories/community` -- every `public` story, newest first, the
  caller's own included
- `GET /stories/{id}` -- one story with its `content`, plus `is_author` and
  `author_is_friend`; 404 if the caller isn't allowed to read it
- `PATCH /stories/{id}` -- edit any subset of the fields above (this is how
  visibility gets changed); author only
- `DELETE /stories/{id}` -- unpublish; the conversation is untouched and can
  be published again
- `GET /conversations/{id}/story` -- the story that conversation was
  published as (with `content`), or `204` if it hasn't been

Feed endpoints leave `content` out -- cards only need the title and summary,
so the full text is fetched per story.

### Friends

One row per request, in the direction it was sent, flipped to `accepted` when
the other side agrees. Declining deletes the row, so the pair can try again.

- `GET /users/search?q=` -- usernames containing `q` (never the caller, never
  anyone's email), each with `relationship`: `none`, `request_sent`,
  `request_received` or `friends`
- `GET /friends` -- accepted friends
- `GET /friends/requests` -- `{"incoming": [...], "outgoing": [...]}`, both
  still pending
- `POST /friends/requests` -- `{"username"}` -> `201` pending. Asking someone
  who already asked you accepts their request instead (`200`).
- `POST /friends/requests/{id}/accept` / `.../decline` -- addressee only
- `DELETE /friends/{userId}` -- unfriend, or cancel a request you sent

## Frontend pages

- `public/config.js` -- `API_BASE_URL` (empty string; same-origin now)
- `public/storage_api.js` -- the only place that calls the API (token storage
  + fetch wrapper); `login.html`/`index.html`'s scripts all go through it
- `public/login.html` + `loginScript.js` -- login/signup form
- `public/index.html` + `profile.js` -- profile page, guarded behind a valid
  session
- `public/index.html`'s "Story" tab + `testChat.js` -- a conversation list +
  chat UI exercising `/conversations` and `/prompts`; user-only input, with a
  canned (not real-AI) assistant reply generated and persisted per message
- `public/stories.js` -- the publish dialog above that chat, the story reader,
  and the Friends/Community feeds, all rendered from `/stories`
- `public/friends.js` -- the Friends tab's people panel (search, requests,
  friend list) on top of `/friends`
- `public/interview.html` + `js/interview.js` + `public/interviewStorage.js` --
  the real interview, opened by the Story tab's "Chat with Your Story Companion" launcher
  in the Story tab's own main pane, as a framed page -- so the interview keeps
  one implementation instead of a second copy of its markup and styles. Claude
  asks the questions over `/api/interview/*` (the per-mode system prompts live in
  `src/server/server.js`), the browser's speech recognition transcribes spoken
  answers, and every exchange is saved through `storage_api.js` as a conversation
  -- one `prompts` row per answer, with the storyteller's words in `content` and
  the question that prompted them in `response` -- so the interview shows up in
  the Story tab and can be published like any other conversation. Ending the
  interview turns the transcript into a chapter and stores it as a `private`
  story on that conversation, which is what chapter-preview.html leads back to
  (`index.html?conversation=<id>`).
  `js/` is served by the server's `/js` route. Framed, the two pages report back
  with `postMessage` (`reellife:close-interview`, `reellife:interview-finished`,
  `reellife:show-conversation`, `reellife:need-login`) instead of navigating a
  window they don't own -- see `testChat.js`.
