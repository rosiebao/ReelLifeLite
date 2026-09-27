"""Password hashing and session-token helpers.

Deliberately kept on stdlib hashlib.pbkdf2_hmac (no bcrypt/passlib dependency),
matching the original login_api.py implementation.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from app.config import settings


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, settings.pbkdf2_iterations
    )
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, _, _ = stored.partition("$")
    salt = bytes.fromhex(salt_hex)
    return secrets.compare_digest(hash_password(password, salt), stored)


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def session_expiry() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(
        hours=settings.session_lifetime_hours
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
