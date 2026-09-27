"""Shared pytest fixtures for the FastAPI test suite.

Each test gets its own throwaway SQLite file (via tmp_path) wired in as the
`get_db` dependency, and its own throwaway media directory swapped in for
app.config.settings.media_root -- so tests never touch the real app.db or
conversation_files/.
"""

import os
import tempfile

# Point the module-level engine (created at import time in app.database) at a
# scratch file too, so importing app.main doesn't create/touch the real app.db.
os.environ.setdefault("DATABASE_URL", f"sqlite:///{tempfile.mkstemp(suffix='.db')[1]}")
os.environ.setdefault("MEDIA_ROOT", tempfile.mkdtemp(prefix="conversation_files_test_"))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.database import Base, get_db
from app.main import app


@pytest.fixture()
def test_engine(tmp_path):
    db_path = tmp_path / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def db_session_factory(test_engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture()
def client(db_session_factory, tmp_path):
    def _override_get_db():
        db = db_session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db

    media_root = tmp_path / "media"
    media_root.mkdir()
    original_media_root = settings.media_root
    settings.media_root = media_root

    with TestClient(app) as test_client:
        yield test_client

    settings.media_root = original_media_root
    app.dependency_overrides.clear()
