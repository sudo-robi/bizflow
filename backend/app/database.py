"""SQLAlchemy 2.0 engine, session factory and request-scoped dependency."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import get_settings

settings = get_settings()

if settings.use_sqlite:
    connect_args = {"check_same_thread": False}
    if settings.sqlite_path == ":memory:":
        engine_options: dict = {"poolclass": StaticPool}
    else:
        engine_options = {}
    engine = create_engine(
        f"sqlite:///{settings.sqlite_path}", connect_args=connect_args, **engine_options
    )
else:
    engine = create_engine(settings.database_url, pool_pre_ping=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables() -> None:
    # Models are imported here so metadata is complete before create_all.
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
