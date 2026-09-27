"""One-off script: logs in a single user via the FastAPI app's login logic directly."""

from app.database import Base, engine, SessionLocal
from app.models import Session as SessionModel
from app.models import User
from app.security import generate_session_token, session_expiry, verify_password

EMAIL = "mangomustardman@gmail.com"
PASSWORD = "miguel423miguel"


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        email = EMAIL.strip().lower()
        user = db.query(User).filter(User.email == email).first()
        if not user or not verify_password(PASSWORD, user.password_hash):
            print("login failed (401): Invalid email or password")
            return

        db.query(SessionModel).filter(SessionModel.user_id == user.id).delete()
        token = generate_session_token()
        db.add(SessionModel(user_id=user.id, token=token, expires_at=session_expiry()))
        db.commit()
        print(f"logged in {email!r} (username {user.username!r}) with token {token}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
