from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ---- Auth ----


class SignupRequest(BaseModel):
    username: str
    email: str
    password: str


class SignupResponse(BaseModel):
    id: int


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    token: str


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str


# ---- Conversations ----


class ConversationCreateResponse(BaseModel):
    conversation_id: int


class ConversationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    conversation_id: int
    user_id: int
    conversation: str | None
    creation_date: datetime
    cost: float


# ---- Prompts ----


class PromptCreate(BaseModel):
    content: str
    input_media_filename: str | None = None
    input_media_base64: str | None = None


class PromptCreateResponse(BaseModel):
    prompt_id: int


class PromptResponseCreate(BaseModel):
    response: str
    output_media_filename: str | None = None
    output_media_base64: str | None = None
    cost: float = 0.0


class PromptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    prompt_id: int
    conversation_id: int
    prompt_time: datetime
    content: str
    response: str | None
    input_media: str | None
    output_media: str | None
