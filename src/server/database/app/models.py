from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utcnow() -> datetime:
    # Naive UTC: SQLite drops tzinfo on round-trip, so storing aware
    # datetimes here would make later comparisons raise TypeError.
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(), default=_utcnow, nullable=False)

    sessions: Mapped[list["Session"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    conversations: Mapped[list["Conversation"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Session(Base):
    """A single active login session token for a user (see login())."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    token: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(), default=_utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="sessions")


class Conversation(Base):
    __tablename__ = "conversation"

    conversation_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Path to this conversation's transcript.txt (see app/storage.py).
    conversation: Mapped[str | None] = mapped_column(Text, nullable=True)
    creation_date: Mapped[datetime] = mapped_column(DateTime(), default=_utcnow, nullable=False)
    cost: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    user: Mapped["User"] = relationship(back_populates="conversations")
    prompts: Mapped[list["Prompt"]] = relationship(
        back_populates="conversation_ref",
        cascade="all, delete-orphan",
        order_by="Prompt.prompt_time",
    )


class Prompt(Base):
    __tablename__ = "prompts"

    prompt_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversation.conversation_id", ondelete="CASCADE"), index=True, nullable=False
    )
    prompt_time: Mapped[datetime] = mapped_column(DateTime(), default=_utcnow, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_media: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_media: Mapped[str | None] = mapped_column(Text, nullable=True)

    conversation_ref: Mapped["Conversation"] = relationship(back_populates="prompts")
