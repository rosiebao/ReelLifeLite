from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.models import Session as SessionModel
from app.models import User
from app.security import utcnow


def get_bearer_token(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    return authorization[len("Bearer ") :].strip()


def get_current_user(
    token: str = Depends(get_bearer_token),
    db: OrmSession = Depends(get_db),
) -> User:
    session = db.query(SessionModel).filter(SessionModel.token == token).first()
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")

    if session.expires_at < utcnow():
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")

    user = db.query(User).filter(User.id == session.user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    return user
