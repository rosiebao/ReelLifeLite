# Accounts & Conversations API

A FastAPI service for user accounts + storing AI conversation history in SQLite.
Serves both auth and conversations from a single app/port (see `app/main.py`).

This is a rewrite of the original stdlib-only implementation (`login_api.py` /
`conversation_api.py` / `db.py`) onto FastAPI + SQLAlchemy + Pydantic, while
deliberately keeping:

- the same table/column layout (`users`, `sessions`, `conversation`, `prompts`)
- the same password hashing (`hashlib.pbkdf2_hmac`, 200k iterations, no
  bcrypt/passlib dependency)
- the same "one active session per user" login model (opaque bearer token
  stored server-side, not a JWT)

## Schema

```
users
  id, username (unique), email (unique), password_hash, created_at

sessions
  id, user_id -> users.id (CASCADE), token (unique), created_at, expires_at

conversation
  conversation_id, user_id -> users.id (CASCADE), conversation (path to
  transcript.txt), creation_date, cost

prompts
  prompt_id, conversation_id -> conversation.conversation_id (CASCADE),
  prompt_time, content, response, input_media (path to file), output_media
  (path to file)
```

Large content — the running conversation transcript and any attached media —
is written to files under `MEDIA_ROOT` (default `conversation_files/`), with
only the file path stored in the database. See `app/storage.py`.

## Project layout

```
app/
  config.py            pydantic-settings config, loaded from .env
  database.py           SQLAlchemy engine/session setup
  models.py              declarative ORM models (User, Session, Conversation, Prompt)
  security.py            pbkdf2_hmac password hashing + session token helpers
  storage.py              transcript/media file helpers
  schemas.py              Pydantic request/response models
  deps.py                  FastAPI dependencies (DB session, bearer-token auth)
  routers/
    auth.py                /signup /login /logout /whoami
    conversations.py       /conversations, /prompts
  main.py                  FastAPI app assembly

conftest.py, test_auth.py, test_conversations.py    pytest suite
login_user.py, signup_user.py                        one-off scripts against app.db
```

## Setup

```bash
cd database
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit if you want non-default settings
uvicorn app.main:app --reload --port 8081
# or: python -m app.main   (reads the port from settings/.env)
```

Interactive docs at http://127.0.0.1:8081/docs

Tables are created automatically on startup (`Base.metadata.create_all` in
`app/main.py`) — no separate migration step.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./app.db` | SQLAlchemy connection string |
| `PORT` | `8081` | Port used by `python -m app.main` (pass `--port` explicitly if running via `uvicorn` directly) |
| `SESSION_LIFETIME_HOURS` | `24` | How long a login session stays valid |
| `PBKDF2_ITERATIONS` | `200000` | PBKDF2-HMAC-SHA256 cost factor for password hashing |
| `MEDIA_ROOT` | `conversation_files` | Where transcripts/media attachments are written |

## Running the tests

```bash
cd database
source .venv/bin/activate
pytest
```

Each test gets its own throwaway SQLite file and media directory (see
`conftest.py`) — nothing touches the real `app.db` or `conversation_files/`.

## API

All endpoints below (except `/signup`, `/login`, `/health`) require
`Authorization: Bearer <token>` from `/login`.

- `POST /signup` — `{"username", "email", "password"}` → `201 {"id": ...}`
- `POST /login` — `{"email", "password"}` → `200 {"token": ...}` (invalidates
  any previous session for that user)
- `POST /logout` — revokes the current session token → `200 {"ok": true}`
- `GET /whoami` → `200 {"id", "username", "email"}`
- `POST /conversations` → `201 {"conversation_id": ...}`
- `GET /conversations` — list the caller's conversations
- `GET /conversations/{id}` — a single conversation (404 if it isn't yours)
- `GET /conversations/{id}/prompts` — that conversation's prompts, oldest first
- `POST /conversations/{id}/prompts` — `{"content", "input_media_filename"?,
  "input_media_base64"?}` → `201 {"prompt_id": ...}`
- `POST /prompts/{id}/response` — `{"response", "output_media_filename"?,
  "output_media_base64"?, "cost"?}` → `200 {"ok": true}` (adds `cost` to the
  conversation's running total)

## Notable differences from the original stdlib version

- Single FastAPI app on one port, instead of two separate `http.server`
  processes on ports 8000/8001.
- Request/response validation and OpenAPI docs come for free from Pydantic +
  FastAPI, instead of manual `dict.get()` checks.
- Foreign keys are enforced by SQLite (`PRAGMA foreign_keys=ON`) and modeled
  explicitly via SQLAlchemy relationships, same as before.
- Auth is still an opaque server-side session token (not a JWT) — the
  intentional constraint here was "keep pbkdf2_hmac and the schema," not
  "adopt JWTs."
