"""One-off script: signs up a single user via the FastAPI app's signup logic directly."""

from app.database import Base, engine, SessionLocal
from app.models import User
from app.security import hash_password

USERNAME = "mangomustardman"
EMAIL = "mangomustardman@gmail.com"
PASSWORD = "miguel423miguel"


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        email = EMAIL.strip().lower()
        if db.query(User).filter(User.email == email).first():
            print(f"Signup failed (409): Email already registered")
            return
        if db.query(User).filter(User.username == USERNAME).first():
            print(f"Signup failed (409): Username already taken")
            return

        user = User(username=USERNAME, email=email, password_hash=hash_password(PASSWORD))
        db.add(user)
        db.commit()
        db.refresh(user)
        print(f"Created user {email!r} (username {USERNAME!r}) with id {user.id}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
