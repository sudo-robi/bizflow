"""Alembic environment: targets the same database as the application."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.pool import StaticPool

from app.config import get_settings
from app.database import Base
from app import models  # noqa: F401 - register all tables

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
target_metadata = Base.metadata


def database_url() -> str:
    if settings.use_sqlite:
        return f"sqlite:///{settings.sqlite_path}"
    return settings.database_url


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = database_url()
    options: dict = {"poolclass": pool.NullPool}
    if url.startswith("sqlite") and settings.sqlite_path == ":memory:":
        options = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}
    engine = create_engine(url, **options)
    with engine.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata, compare_type=True
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
