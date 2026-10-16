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
family.js         /family -- the Family tab's tree, and family invitations
profile.js        /profile, /profile/photo, /users/{id}/profile -- the profile page
stories.js        /stories -- publishing a conversation for others to read
storyPhotos.js    /stories/photos, /story-photos/{name} -- pictures published
                   with a story
db.js             node:sqlite connection + schema (CREATE TABLE IF NOT EXISTS)
security.js       password hashing + session token helpers
storage.js        transcript/media file helpers
errors.js         ApiError(status, message)
test/             node --test suite (auth, conversations, drafts, family,
                   friends, interview, stories, story photos)
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

### On Render (or any host)

`.env` is git-ignored, so **it is never deployed** -- a fresh Render service
has no `INTERVIEW_AI`, and "End" just joins the answers (the Publish form says
so). Set these in the service's **Environment** tab, or let `render.yaml` add
them when the Blueprint is synced:

| Variable | Value |
|---|---|
| `INTERVIEW_AI` | `bedrock` |
| `INTERVIEW_AWS_REGION` | `us-east-1` |
| `AWS_BEARER_TOKEN_BEDROCK` | the Bedrock API key (secret -- `render.yaml` only declares it, with `sync: false`) |

(`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` work instead of the key.)
Saving environment variables redeploys the service. Check the deploy log for:

```
Interview AI: Claude (anthropic.claude-opus-5) on AWS Bedrock in us-east-1
```

"Interview AI: off" means `INTERVIEW_AI` isn't set; a WARNING about
credentials means the key is missing. Right after that the server tries
Claude once and logs `Interview AI: connection to Claude OK` or
`Interview AI: NOT WORKING -- <what to fix>`:

| Log says | Fix |
|---|---|
| `the server's AWS key was rejected` | `AWS_BEARER_TOKEN_BEDROCK` is wrong or expired -- paste the key only (it starts `ABSK`), no quotes and no `AWS_BEARER_TOKEN_BEDROCK=` |
| `the AWS user arn:aws:iam::...:user/<name> isn't allowed to use Claude` | The key works, but its IAM user lacks permission (Bedrock's own error says `not authorized to perform: bedrock-mantle:CreateInference`). In the AWS console: **IAM → Users → `<name>` → Add permissions → Attach policies directly → `AmazonBedrockMantleInferenceAccess`**. Takes effect within a minute; no redeploy needed |
| `the server has no AWS key` | `AWS_BEARER_TOKEN_BEDROCK` isn't set on the service |
| `the AI model isn't available in ...` | `INTERVIEW_AWS_REGION` should be `us-east-1` |

The Story tab shows the same "isn't set up correctly" message instead of
"try again" when End hits one of these. (Surrounding quotes and a leading
`AWS_BEARER_TOKEN_BEDROCK=` are stripped automatically.)

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
- `DELETE /conversations/{id}` -- delete an interview for good: its prompts,
  the drafts written from it, and its transcript and media on disk. A story
  published from it stays up (delete it with `DELETE /stories/{id}`); its
  `conversation_id` becomes `null`. 404 if it isn't yours
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
`visibility` is who can read it: `private` (author only), `public`
(everyone, the Community tab), or any mix of `friends` (accepted friends) and
`family` (accounts linked to the author's family tree, in either direction --
someone in your tree, or the owner of a tree you're in). Send it as a list
(`["friends", "family"]`) or a comma-separated string (`"friends,family"`);
it's stored and returned as the string, in that order, alongside `audiences`
as a list (`[]` for `private`). `public` already includes friends and family,
so it's stored alone; `private` can't be combined with anything.

- `POST /stories` -- `{"conversation_id", "title", "summary"?, "content"?,
  "tags"?, "place"?, "time_period"?, "photo"?, "visibility"?, "photo_ids"?}` ->
  `201` with the story. `content` defaults to the author's own messages in
  that conversation (the assistant's replies are interview prompts, not the
  story). Publishing the same conversation again edits its story and returns
  `200` -- there's one story per conversation.
- `GET /stories/mine` -- the caller's own stories, newest first
- `GET /stories/friends` -- stories friends and family have shared with the
  caller: shared with `friends` by a friend, with `family` by family, or
  `public` from either (not the caller's own)
- `GET /stories/community` -- every `public` story, newest first, the
  caller's own included
- `GET /stories/{id}` -- one story with its `content`, plus `is_author` and
  `author_is_friend`; 404 if the caller isn't allowed to read it
- `PATCH /stories/{id}` -- edit any subset of the fields above (this is how
  visibility gets changed); author only
- `DELETE /stories/{id}` -- delete (unpublish) a story for good; the
  conversation is untouched and can be published again. Also works for a
  story whose conversation was deleted. Author only (404 otherwise)
- `GET /conversations/{id}/story` -- the story that conversation was
  published as (with `content`), or `204` if it hasn't been

Feed endpoints leave `content` out -- cards only need the title and summary,
so the full text is fetched per story.

#### Story photos

Pictures published together with a story. Each one is uploaded on its own
first, then listed (in order) in the story's `photo_ids` when it's published
or edited (`POST /stories`, `PATCH /stories/{id}`). Every story comes back
with `photos` (`[{"photo_id", "url"}]`, in order; `[]` for none) and `photo`,
the cover: the first photo's URL, or the old free-text field when there are
none.

- `POST /stories/photos` -- `{"filename", "data_base64"}`, JPG or PNG (checked
  by the file's bytes), up to 5 MB (`413` beyond) -> `201 {"photo_id", "url"}`.
  Not published until a story lists it; ones never listed are removed after a
  day. At most 30 can be waiting at once (`429`).
- `photo_ids` on a story -- up to 10, each your own upload that isn't on
  another story (`400` otherwise, and nothing is saved). The list replaces the
  story's photos: any left out are deleted, files and all. Leaving
  `photo_ids` out keeps the photos as they are; `[]` removes them all.
  Deleting a story deletes its photos.
- `GET /story-photos/{name}` -- the image itself. No login (`<img>` can't send
  the token), like profile photos: the URL is only handed out with a story
  you can read, and the random name keeps it from being guessed. Stored under
  `MEDIA_ROOT/story_photos/`.

### Profile

The profile page's details, on top of the login ones. Every field is
optional; location and email are hidden from other people until switched on.

- `GET /profile` -- your own profile: `username`, `email`, `first_name`,
  `last_name`, `location`, `bio`, `photo_url`, `profile_visibility`
  (`friends` | `community`), `show_location`, `show_email`, `created_at`
- `PUT /profile` -- any of those fields (except `photo_url`/`created_at`);
  only the ones sent change. Username and email follow `/signup`'s rules
  (`409` if taken); the new email is the one to log in with.
- `PUT /profile/photo` -- `{"filename", "data_base64"}`, JPG or PNG (checked by
  the file's bytes), up to 5 MB (`413` beyond). Replaces and deletes the old
  one. Stored under `MEDIA_ROOT/profile_photos/` with a random name.
- `DELETE /profile/photo` -- back to the default picture
- `GET /profile-photos/{name}` -- the image itself (no login: `<img>` can't
  send the token, so the random name is what keeps it private)
- `GET /users/{id}/profile` -- someone else's profile. `friends` profiles are
  `404` to anyone who isn't a friend; `location`/`email` are `null` unless
  they're switched on.

### Family

Your family tree: `rows` is a list of generations, top (oldest) first, each
a list of `members`. Each member has `member_id`, `name`, `relationship`
("Sister"), `email`, `is_self` (your own node, only one) and, from the
server, `photo_url` (your profile photo for your own node, the linked
account's for someone on ReelLife), `status` (`self`, `joined`, `invited`,
`not_invited`) and `linked_user` (`{id, username}` once they're on ReelLife).

- `GET /family` -> `{"rows", "seeded"}`. `seeded` is false until the first
  save, which is how the page knows to start a new account off with a tree.
- `PUT /family` -- the whole tree. Send `member_id` back for members already
  saved and they're updated in place, even if they moved to another
  generation; members left out are removed (with their invitation). A member
  can be linked to an account with `linked_user_id`, but only to one of your
  friends (an existing link is always kept), and only once per tree.
- `POST /family/members/{id}/invite` -- `{"email"?}` -> `{"token", "member"}`.
  Makes an invitation, or returns the existing one so a link already sent
  keeps working. The page turns the token into `index.html?invite=<token>`
  and opens the user's email app (there's no mail server), or copies it.
  `409` once they've joined.
- `GET /family/invites/{token}` -- who it's from and which member it is, plus
  `own` when it's your own invitation; `404` for a used or cancelled link.
- `POST /family/invites/{token}/accept` -- links your account to that member
  and makes the two of you friends. The link is then used up.

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
- `public/index.html` + `profile.js` -- the session gate for the page, and the
  profile tab: photo and personal details (Save/Cancel)
- `public/family.js` -- the Family tab: the tree (one band per generation,
  with + Member / − Member / + Layer / × Layer beside it), the panel for the
  selected person (invite by email or link), Add member (a friend already on
  ReelLife) and Invite family (someone new). Adding asks who they're related
  to (the selected person to start with) and how, and works out their
  generation and relationship to you from that. Also offers an invitation link
  that was opened (`?invite=`; `authGuard.js` keeps it across signing in)
- `public/index.html`'s "Story" tab + `testChat.js` -- the interview: pick a
  topic, start an interview, answer (typed, or out loud with 🎤 / ✋
  Hands-free), skip a question, and
  "End" to have it written up as a story in the publish dialog, all through `/interview`.
  An interview is deleted with the trash button beside End, or on its row
  under "Your Interviews". A published story is deleted (`DELETE
  /stories/{id}`, `stories.js`) the same way: the trash button beside "Edit
  story" in the reader, or on its row under "Your Stories". The publish
  dialog's "Photos" adds pictures to a story (each uploaded as it's picked),
  reorders or removes them; the first is the cover on the Friends and
  Community cards, and both story readers show them all above the text
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
