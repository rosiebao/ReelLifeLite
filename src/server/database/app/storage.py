"""Conversation transcript and media-attachment storage on disk.

Large content (the running transcript, attached media) is kept out of the
database and written under settings.media_root, with only the resulting
path stored on the relevant row.
"""

import base64
import secrets
from pathlib import Path

from app.config import settings


def conversation_dir(conversation_id: int) -> Path:
    directory = settings.media_root / str(conversation_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def transcript_path(conversation_id: int) -> Path:
    return conversation_dir(conversation_id) / "transcript.txt"


def append_transcript(conversation_id: int, line: str) -> None:
    with transcript_path(conversation_id).open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def save_media(conversation_id: int, filename: str, base64_data: str) -> str:
    """Decode base64 file data and save it under this conversation's media folder.

    Only the base filename (never any directory components) is used, so a
    caller-supplied name like "../../evil.txt" can't write outside of
    settings.media_root.
    """
    safe_name = f"{secrets.token_hex(4)}_{Path(filename).name}"
    directory = conversation_dir(conversation_id) / "media"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / safe_name
    path.write_bytes(base64.b64decode(base64_data))
    return str(path)
