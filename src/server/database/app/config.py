from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./app.db"
    port: int = 8081
    # How long a login session stays valid before whoami/logout start rejecting it.
    session_lifetime_hours: int = 24
    # Cost of a PBKDF2-HMAC-SHA256 password hash; matches the original stdlib implementation.
    pbkdf2_iterations: int = 200_000
    # Where conversation transcripts and attached media are written.
    media_root: Path = Path("conversation_files")

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
