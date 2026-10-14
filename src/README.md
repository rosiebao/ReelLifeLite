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
drafts.js         /drafts -- every story written when an interview ends ("End")
interview.js      /conversations/{id}/interview/* -- the Story tab's interview
interviewer.js    what the interviewer says: Claude on AWS Bedrock, or canned
                   questions when that isn't switched on
friends.js        /friends, /users/search -- the friend graph
stories.js        /stories -- publishing a conversation for others to read
db.js             node:sqlite connection + schema (CREATE TABLE IF NOT EXISTS)
security.js       password hashing + session token helpers
storage.js        transcript/media file helpers
errors.js         ApiError(status, message)
test/             node --test suite (auth, conversations, drafts, family,
                   friends, interview, stories)
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
Tables are created automatically on startup -- no migration step. Settings
can also go in `frontend/.env` (see `.env.example`), which `npm start` reads.

### Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `6767` | Port the Express app listens on |
| `DATABASE_PATH` | `./app.db` | SQLite file path. A folder (e.g. `/data`, a mounted disk on Render) gets `app.db` inside it; missing folders are created |
| `MEDIA_ROOT` | `./conversation_files` | Where transcripts/media attachments are written |
| `INTERVIEW_AI` | *(unset)* | `bedrock` to have Claude run the Story tab's interview; anything else uses canned questions |
| `INTERVIEW_MODEL` | `anthropic.claude-opus-5` | Bedrock model ID for the interviewer |
| `INTERVIEW_AWS_REGION` | `AWS_REGION` | Bedrock region for the interviewer, e.g. `us-east-1`. Wins over `AWS_REGION`, which a shell often sets for something else; a 404 "model does not exist" usually means the model isn't served in that region |
| `AWS_REGION` | -- | Bedrock region when `INTERVIEW_AWS_REGION` isn't set (only with `INTERVIEW_AI=bedrock`) |

### Turning on the AI interviewer

The interview came over from the ReelLife repo (`src/server/server.js`,
`src/js/interview.js`), which called Claude through AWS Bedrock. It still
does, via Anthropic's `@anthropic-ai/bedrock-sdk`, but only when switched on
-- otherwise the interviewer asks from a short canned list and "End" just
gathers your answers into the story, so the app runs for anyone without AWS
access.

To switch it on for every `npm start`, do this once:

```bash
cd frontend
cp .env.example .env
```

then open `.env` and fill in one of the AWS credential options (or leave them
out to use a profile from `aws configure`). `app.js` loads `.env` on startup,
and the log says which interviewer is running:

```
Interview AI: Claude (anthropic.claude-opus-5) on AWS Bedrock in us-east-1
```

`.env` is git-ignored, so keys never get committed. Anything set in the shell
overrides it -- `INTERVIEW_AI=off npm start` runs one session without Claude.
The tests never read `.env`. The AWS account needs Bedrock access to the model
in `INTERVIEW_MODEL`.

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

### Interview

An interview is a conversation where the replies come from the interviewer.
Its first question is stored on the conversation (`interview_mode`,
`opening_question`); after that each prompt is one answer (`content`) and the
question asked next (`response`). Each call returns `{"question"}`; a failed
question is `502` (or `503` if Bedrock is busy), and the answer is kept.

- `POST /conversations/{id}/interview/start` -- `{"mode"}`, one of `Stages`,
  `People`, `Moments`, `Lessons` -> `201 {"mode", "question"}`. Starting again
  returns the same question (`200`).
- `POST /conversations/{id}/interview/answer` -- `{"content"}` ->
  `201 {"prompt_id", "question"}`
- `POST /conversations/{id}/interview/skip` -- replaces the latest question
  with a different one; if the latest answer never got a question, asks it
- `POST /conversations/{id}/interview/story` -> `{"story", "draft_id",
  "created_at"}`, a first-person draft of the interview for the publish
  dialog. Each draft is also kept in `story_drafts` (see Drafts below);
  the story itself is only stored by publishing.

### Drafts

Every story written when an interview ends ("End"), kept server-side. Drafts
are private and never edited. No page shows them any more (the "My Stories"
tab was removed); the API stays so nothing already written is lost.

- `GET /drafts` -- the caller's drafts, newest first: `draft_id`,
  `conversation_id`, `interview_mode`, `content`, `created_at`
- `DELETE /drafts/{id}` -- remove one from the history (404 if it isn't yours)

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
- `public/index.html`'s "Story" tab + `testChat.js` -- the interview: pick a
  mode, start an interview, answer (typed or out loud), skip a question, and
  "End" to have it written up as a story in the publish dialog, all through `/interview`
- `public/voiceInput.js` -- answering out loud with the browser's speech
  recognition (Chrome, Edge, Safari); dictates into the answer box with a live
  caption, and the mic button hides where it isn't supported. Restarts itself
  when Chrome ends a session, reports mic problems (offline, blocked, no
  microphone), and releases the mic while the tab is hidden
- `public/voiceOutput.js` -- reads each new question aloud with the browser's
  text-to-speech (🔊 Voice on/off, remembered; 🔊 Listen on every question).
  The mic is switched off while a question plays so the interviewer's own voice
  isn't taken for the answer. "✋ Hands-free" sends an answer once you stop
  talking; it is remembered on the device and holds for every interview until
  turned off (picking "Type" turns it off too)
- `public/sessionWatch.js` -- while an interview is open, keeps checking
  (`/whoami`, every minute and on tab focus / reconnect / another tab's
  sign-out) that you're still signed in as the same account. If not, the mic and
  voice shut off, unsent words are dropped, and you're sent to sign in. The mic
  also won't open without a fresh check. The server enforces the session and
  conversation owner on every call regardless. A dropped connection isn't
  treated as signed out
- Voice and session logic have Node tests with fake browser APIs:
  `test/voiceInput.test.js`, `voiceOutput.test.js`, `sessionWatch.test.js`.
  Chrome sends speech-recognition audio to Google's servers, which matters
  for a personal-stories app
- `public/stories.js` -- the publish dialog above that chat (which asks before
  closing with unsaved edits), the story reader, and the Friends/Community
  feeds, all rendered from `/stories`
- `public/friends.js` -- the Friends tab's people panel (search, requests,
  friend list) on top of `/friends`
