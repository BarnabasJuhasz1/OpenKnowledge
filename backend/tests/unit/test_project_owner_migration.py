"""project-ownership-01: projects.user_id column + retrofit migration."""
from __future__ import annotations

from sqlalchemy import create_engine, inspect, text

from app.db.database import _apply_migrations
from app.db.orm_models import DBProject


def _columns(engine, table: str) -> set[str]:
    return {c["name"] for c in inspect(engine).get_columns(table)}


def test_model_has_nullable_user_id():
    col = DBProject.__table__.c.user_id
    assert col.nullable is True


def test_migration_retrofits_user_id_onto_legacy_db(tmp_path):
    """A pre-existing projects table without user_id gets the column (idempotently)."""
    db = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{db}")

    # Simulate an old schema: projects without user_id.
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE projects ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)"
            )
        )
        conn.execute(text("INSERT INTO projects (name) VALUES ('legacy')"))

    assert "user_id" not in _columns(engine, "projects")

    with engine.begin() as conn:
        _apply_migrations(conn)
    assert "user_id" in _columns(engine, "projects")

    # Idempotent: running again is a no-op, not an error.
    with engine.begin() as conn:
        _apply_migrations(conn)
    assert "user_id" in _columns(engine, "projects")

    # Legacy row stays in the null bucket; a value can be written.
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT user_id FROM projects")).scalars().all()
        assert rows == [None]
        conn.execute(text("UPDATE projects SET user_id = 7 WHERE name = 'legacy'"))
        assert conn.execute(text("SELECT user_id FROM projects")).scalar_one() == 7

    # Index was created for the retrofitted column.
    index_names = {ix["name"] for ix in inspect(engine).get_indexes("projects")}
    assert "ix_projects_user_id" in index_names

    engine.dispose()
