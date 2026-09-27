from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session as OrmSession

from app.database import get_db
from app.deps import get_bearer_token, get_current_user
from app.models import Session as SessionModel
from app.models import User
from app.schemas import LoginRequest, SignupRequest, SignupResponse, TokenResponse, UserRead
from app.security import generate_session_token, hash_password, session_expiry, verify_password

router = APIRouter(tags=["auth"])


@router.post("/signup", response_model=SignupResponse, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, db: OrmSession = Depends(get_db)):
    username = payload.username.strip()
    email = payload.email.strip().lower()
    password = payload.password

    if not username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")
    if not password or len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="Username already taken")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(username=username, email=email, password_hash=hash_password(password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return SignupResponse(id=user.id)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: OrmSession = Depends(get_db)):
    email = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Only one active session per user.
    db.query(SessionModel).filter(SessionModel.user_id == user.id).delete()
    token = generate_session_token()
    db.add(SessionModel(user_id=user.id, token=token, expires_at=session_expiry()))
    db.commit()
    return TokenResponse(token=token)


@router.post("/logout")
def logout(token: str = Depends(get_bearer_token), db: OrmSession = Depends(get_db)):
    db.query(SessionModel).filter(SessionModel.token == token).delete()
    db.commit()
    return {"ok": True}


@router.get("/whoami", response_model=UserRead)
def whoami(current_user: User = Depends(get_current_user)):
    return current_user
