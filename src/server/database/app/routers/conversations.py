from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.deps import get_current_user
from app.models import Conversation, Prompt, User
from app.schemas import (
    ConversationCreateResponse,
    ConversationRead,
    PromptCreate,
    PromptCreateResponse,
    PromptRead,
    PromptResponseCreate,
)
from app.security import utcnow
from app.storage import append_transcript, save_media, transcript_path

router = APIRouter(tags=["conversations"])


def _owned_conversation(conversation_id: int, user: User, db: OrmSession) -> Conversation:
    conversation = (
        db.query(Conversation)
        .filter(Conversation.conversation_id == conversation_id, Conversation.user_id == user.id)
        .first()
    )
    if conversation is None:
        # 404 rather than 403 so we don't reveal that the id exists.
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.post("/conversations", response_model=ConversationCreateResponse, status_code=status.HTTP_201_CREATED)
def create_conversation(
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    conversation = Conversation(user_id=current_user.id, conversation=None, cost=0.0)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)

    path = transcript_path(conversation.conversation_id)
    path.write_text("", encoding="utf-8")
    conversation.conversation = str(path)
    db.commit()
    return ConversationCreateResponse(conversation_id=conversation.conversation_id)


@router.get("/conversations", response_model=list[ConversationRead])
def list_conversations(
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    return (
        db.query(Conversation)
        .filter(Conversation.user_id == current_user.id)
        .order_by(Conversation.creation_date)
        .all()
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationRead)
def get_conversation(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    return _owned_conversation(conversation_id, current_user, db)


@router.get("/conversations/{conversation_id}/prompts", response_model=list[PromptRead])
def get_prompts(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    _owned_conversation(conversation_id, current_user, db)
    return (
        db.query(Prompt)
        .filter(Prompt.conversation_id == conversation_id)
        .order_by(Prompt.prompt_time)
        .all()
    )


@router.post(
    "/conversations/{conversation_id}/prompts",
    response_model=PromptCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_prompt(
    conversation_id: int,
    payload: PromptCreate,
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    _owned_conversation(conversation_id, current_user, db)
    if not payload.content:
        raise HTTPException(status_code=400, detail="Prompt content cannot be empty")

    input_media_path = None
    if payload.input_media_base64:
        input_media_path = save_media(
            conversation_id, payload.input_media_filename or "input", payload.input_media_base64
        )

    prompt = Prompt(
        conversation_id=conversation_id,
        content=payload.content,
        response=None,
        input_media=input_media_path,
        output_media=None,
    )
    db.add(prompt)
    db.commit()
    db.refresh(prompt)
    append_transcript(conversation_id, f"[{utcnow().isoformat()}] USER: {payload.content}")
    return PromptCreateResponse(prompt_id=prompt.prompt_id)


@router.post("/prompts/{prompt_id}/response")
def add_response(
    prompt_id: int,
    payload: PromptResponseCreate,
    current_user: User = Depends(get_current_user),
    db: OrmSession = Depends(get_db),
):
    prompt = db.query(Prompt).filter(Prompt.prompt_id == prompt_id).first()
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    _owned_conversation(prompt.conversation_id, current_user, db)

    if not payload.response:
        raise HTTPException(status_code=400, detail="Response content cannot be empty")

    output_media_path = None
    if payload.output_media_base64:
        output_media_path = save_media(
            prompt.conversation_id, payload.output_media_filename or "output", payload.output_media_base64
        )

    prompt.response = payload.response
    prompt.output_media = output_media_path
    db.commit()
    append_transcript(prompt.conversation_id, f"[{utcnow().isoformat()}] AI: {payload.response}")

    conversation = (
        db.query(Conversation).filter(Conversation.conversation_id == prompt.conversation_id).first()
    )
    conversation.cost = conversation.cost + payload.cost
    db.commit()
    return {"ok": True}
