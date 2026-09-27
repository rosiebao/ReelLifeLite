"""Tests for the /signup, /login, /logout, /whoami routes (app/routers/auth.py).

Run with: pytest test_auth.py
"""

from app.models import Session as SessionModel
from app.security import utcnow


def _signup(client, username="ada", email="ada@example.com", password="password123"):
    return client.post("/signup", json={"username": username, "email": email, "password": password})


def _login(client, email="ada@example.com", password="password123"):
    return client.post("/login", json={"email": email, "password": password})


def test_signup_creates_user(client):
    resp = _signup(client)
    assert resp.status_code == 201
    assert "id" in resp.json()


def test_signup_normalizes_email_case(client):
    _signup(client, email="Ada@Example.com")
    resp = _login(client, email="ada@example.com")
    assert resp.status_code == 200


def test_signup_rejects_duplicate_email(client):
    _signup(client, username="ada", email="ada@example.com")
    resp = _signup(client, username="ada2", email="ada@example.com")
    assert resp.status_code == 409


def test_signup_rejects_duplicate_username(client):
    _signup(client, username="ada", email="ada@example.com")
    resp = _signup(client, username="ada", email="ada2@example.com")
    assert resp.status_code == 409


def test_signup_rejects_empty_username(client):
    resp = _signup(client, username="   ")
    assert resp.status_code == 400


def test_signup_rejects_short_password(client):
    resp = _signup(client, password="short")
    assert resp.status_code == 400


def test_signup_rejects_invalid_email(client):
    resp = _signup(client, email="not-an-email")
    assert resp.status_code == 400


def test_login_success_returns_token(client):
    _signup(client)
    resp = _login(client)
    assert resp.status_code == 200
    assert len(resp.json()["token"]) > 20


def test_login_rejects_wrong_password(client):
    _signup(client)
    resp = _login(client, password="wrongpassword")
    assert resp.status_code == 401


def test_login_rejects_unknown_email(client):
    resp = _login(client, email="ghost@example.com")
    assert resp.status_code == 401


def test_login_invalidates_previous_session(client):
    _signup(client)
    old_token = _login(client).json()["token"]
    new_token = _login(client).json()["token"]

    assert old_token != new_token
    resp = client.get("/whoami", headers={"Authorization": f"Bearer {old_token}"})
    assert resp.status_code == 401
    resp = client.get("/whoami", headers={"Authorization": f"Bearer {new_token}"})
    assert resp.status_code == 200


def test_whoami_returns_user_for_valid_token(client):
    _signup(client)
    token = _login(client).json()["token"]
    resp = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["username"] == "ada"
    assert resp.json()["email"] == "ada@example.com"


def test_whoami_rejects_bad_token(client):
    resp = client.get("/whoami", headers={"Authorization": "Bearer not-a-real-token"})
    assert resp.status_code == 401


def test_whoami_without_token_returns_401(client):
    resp = client.get("/whoami")
    assert resp.status_code == 401


def test_logout_invalidates_token(client):
    _signup(client)
    token = _login(client).json()["token"]
    resp = client.post("/logout", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    resp = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_expired_session_is_rejected(client, db_session_factory):
    from datetime import timedelta

    _signup(client)
    token = _login(client).json()["token"]

    db = db_session_factory()
    session = db.query(SessionModel).filter(SessionModel.token == token).first()
    session.expires_at = utcnow() - timedelta(hours=1)
    db.commit()
    db.close()

    resp = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_unknown_route_returns_404(client):
    resp = client.get("/does-not-exist")
    assert resp.status_code == 404
