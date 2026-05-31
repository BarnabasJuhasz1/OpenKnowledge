from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./openknowledge.db")

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db() -> None:
    from . import orm_models  # noqa: F401 — ensures models are registered
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_apply_migrations)


def _apply_migrations(conn) -> None:
    """Add columns that create_all cannot retrofit onto an existing SQLite table."""
    from sqlalchemy import inspect, text

    inspector = inspect(conn)
    if "bookshelf_items" in inspector.get_table_names():
        columns = {col["name"] for col in inspector.get_columns("bookshelf_items")}
        if "paper_json" not in columns:
            conn.execute(text("ALTER TABLE bookshelf_items ADD COLUMN paper_json TEXT"))

    if "papers" in inspector.get_table_names():
        columns = {col["name"] for col in inspector.get_columns("papers")}
        if "predicted_main_archetype" not in columns:
            conn.execute(text("ALTER TABLE papers ADD COLUMN predicted_main_archetype VARCHAR"))
        if "predicted_second_tier_archetype" not in columns:
            conn.execute(text("ALTER TABLE papers ADD COLUMN predicted_second_tier_archetype VARCHAR"))
