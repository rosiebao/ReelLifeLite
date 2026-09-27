"""Tests for the /conversations and /prompts routes (app/routers/conversations.py).

Run with: pytest test_conversations.py
"""

import base64
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Prompt


def _signup_and_login(client, username, email, password="password123"):
    client.post("/signup", json={"username": username, "email": email, "password": password})
    token = client.post("/login", json={"email": email, "password": password}).json()["token"]
    return token


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_create_conversation_creates_row_and_transcript_file(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    resp = client.post("/conversations", headers=_auth(token))
    assert resp.status_code == 201
    conversation_id = resp.json()["conversation_id"]

    resp = client.get(f"/conversations/{conversation_id}", headers=_auth(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["cost"] == 0.0
    assert body["creation_date"] is not None

    transcript_path = Path(body["conversation"])
    assert transcript_path.exists()
    assert transcript_path.read_text(encoding="utf-8") == ""


def test_add_prompt_creates_row_and_appends_transcript(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]

    resp = client.post(
        f"/conversations/{conversation_id}/prompts", json={"content": "Hello AI"}, headers=_auth(token)
    )
    assert resp.status_code == 201

    resp = client.get(f"/conversations/{conversation_id}/prompts", headers=_auth(token))
    prompts = resp.json()
    assert len(prompts) == 1
    assert prompts[0]["content"] == "Hello AI"
    assert prompts[0]["response"] is None
    assert prompts[0]["input_media"] is None

    conversation = client.get(f"/conversations/{conversation_id}", headers=_auth(token)).json()
    transcript = Path(conversation["conversation"]).read_text(encoding="utf-8")
    assert "USER: Hello AI" in transcript


def test_add_prompt_rejects_empty_content(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    resp = client.post(
        f"/conversations/{conversation_id}/prompts", json={"content": ""}, headers=_auth(token)
    )
    assert resp.status_code == 400


def test_add_prompt_rejects_unknown_conversation(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    resp = client.post("/conversations/999999/prompts", json={"content": "Hello"}, headers=_auth(token))
    assert resp.status_code == 404


def test_add_prompt_saves_input_media_and_sanitizes_filename(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]

    data = base64.b64encode(b"raw file bytes").decode("ascii")
    resp = client.post(
        f"/conversations/{conversation_id}/prompts",
        json={
            "content": "See attached",
            "input_media_filename": "../../evil.txt",
            "input_media_base64": data,
        },
        headers=_auth(token),
    )
    assert resp.status_code == 201

    prompts = client.get(f"/conversations/{conversation_id}/prompts", headers=_auth(token)).json()
    media_path = Path(prompts[0]["input_media"])
    assert media_path.exists()
    assert media_path.read_bytes() == b"raw file bytes"
    assert ".." not in media_path.parts


def test_add_response_updates_prompt_and_accumulates_cost(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]

    prompt_id_1 = client.post(
        f"/conversations/{conversation_id}/prompts", json={"content": "Question one"}, headers=_auth(token)
    ).json()["prompt_id"]
    client.post(
        f"/prompts/{prompt_id_1}/response",
        json={"response": "Answer one", "cost": 0.05},
        headers=_auth(token),
    )
    prompt_id_2 = client.post(
        f"/conversations/{conversation_id}/prompts", json={"content": "Question two"}, headers=_auth(token)
    ).json()["prompt_id"]
    client.post(
        f"/prompts/{prompt_id_2}/response",
        json={"response": "Answer two", "cost": 0.02},
        headers=_auth(token),
    )

    prompts = client.get(f"/conversations/{conversation_id}/prompts", headers=_auth(token)).json()
    assert prompts[0]["response"] == "Answer one"

    conversation = client.get(f"/conversations/{conversation_id}", headers=_auth(token)).json()
    assert conversation["cost"] == pytest.approx(0.07)

    transcript = Path(conversation["conversation"]).read_text(encoding="utf-8")
    assert "AI: Answer one" in transcript
    assert "AI: Answer two" in transcript


def test_add_response_rejects_unknown_prompt(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    resp = client.post("/prompts/999999/response", json={"response": "Answer"}, headers=_auth(token))
    assert resp.status_code == 404


def test_add_response_rejects_empty_response(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    prompt_id = client.post(
        f"/conversations/{conversation_id}/prompts", json={"content": "Question"}, headers=_auth(token)
    ).json()["prompt_id"]
    resp = client.post(f"/prompts/{prompt_id}/response", json={"response": ""}, headers=_auth(token))
    assert resp.status_code == 400


def test_get_conversation_not_found(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    resp = client.get("/conversations/999999", headers=_auth(token))
    assert resp.status_code == 404


def test_get_prompts_ordered_by_time(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    for content in ["first", "second", "third"]:
        client.post(
            f"/conversations/{conversation_id}/prompts", json={"content": content}, headers=_auth(token)
        )
    prompts = client.get(f"/conversations/{conversation_id}/prompts", headers=_auth(token)).json()
    assert [p["content"] for p in prompts] == ["first", "second", "third"]


def test_list_conversations_scoped_to_user(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    other_token = _signup_and_login(client, "grace", "grace@example.com")

    conv_a = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    conv_b = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    client.post("/conversations", headers=_auth(other_token))

    conversations = client.get("/conversations", headers=_auth(token)).json()
    ids = {c["conversation_id"] for c in conversations}
    assert ids == {conv_a, conv_b}


def test_requires_authentication(client):
    resp = client.get("/conversations")
    assert resp.status_code == 401


def test_cannot_access_another_users_conversation(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    other_token = _signup_and_login(client, "grace", "grace@example.com")

    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]
    resp = client.get(f"/conversations/{conversation_id}", headers=_auth(other_token))
    assert resp.status_code == 404


def test_prompt_with_base64_media_round_trips(client):
    token = _signup_and_login(client, "ada", "ada@example.com")
    conversation_id = client.post("/conversations", headers=_auth(token)).json()["conversation_id"]

    payload = base64.b64encode(b"hello from a file").decode("ascii")
    client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"content": "here's a file", "input_media_filename": "note.txt", "input_media_base64": payload},
        headers=_auth(token),
    )

    prompts = client.get(f"/conversations/{conversation_id}/prompts", headers=_auth(token)).json()
    media_path = prompts[0]["input_media"]
    assert Path(media_path).read_bytes() == b"hello from a file"


def test_foreign_key_enforced_at_db_level(db_session_factory):
    db = db_session_factory()
    db.add(
        Prompt(
            conversation_id=999999,
            content="orphaned prompt",
            response=None,
            input_media=None,
            output_media=None,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.close()
