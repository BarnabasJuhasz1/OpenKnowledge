"""okgraph-snapshots-01: graph_snapshots table + project-delete cascade.

The snapshot inherits ownership from its project (no user_id column); the
pipeline output lives in two plain-JSON Text blobs. Deleting a project must take
its snapshots with it via `delete_project_data` (the path DELETE /projects uses).
"""
from __future__ import annotations

import json

from sqlalchemy import select

from app.db.database import AsyncSessionLocal, Base
from app.db.orm_models import DBGraphSnapshot, DBProject
from app.services.retrieval.persistence import delete_project_data


def test_table_is_registered_without_user_id():
    """create_all (run by init_db / the test harness) builds the table; the
    snapshot has no user_id — ownership comes from the project."""
    table = Base.metadata.tables["graph_snapshots"]
    cols = set(table.columns.keys())
    assert "user_id" not in cols
    assert {"project_id", "name", "graph_json", "summaries_json"} <= cols
    # project_id is the cap/list index.
    assert table.c.project_id.index is True
    # both blobs are required.
    assert table.c.graph_json.nullable is False
    assert table.c.summaries_json.nullable is False


async def test_insert_and_read_back_both_blobs():
    graph = {
        "nodes": [{"paper_id": "n1"}],
        "edges": [],
        "seedId": "n1",
        "resolution": 1.0,
        "maxLevels": 3,
        "directionalSplit": True,
    }
    summaries = [
        {"level": 0, "community": 2, "title": "T", "summary": "S", "bullets": ["a", "b"]}
    ]

    async with AsyncSessionLocal() as db:
        proj = DBProject(name="snap-fixture", user_id=None)
        db.add(proj)
        await db.flush()
        pid = proj.id
        db.add(
            DBGraphSnapshot(
                project_id=pid,
                name="my snapshot",
                seed_id="n1",
                node_count=1,
                cluster_count=1,
                graph_json=json.dumps(graph),
                summaries_json=json.dumps(summaries),
            )
        )
        await db.commit()

    try:
        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    select(DBGraphSnapshot).where(DBGraphSnapshot.project_id == pid)
                )
            ).scalar_one()
            assert row.name == "my snapshot"
            assert row.seed_id == "n1"
            assert row.node_count == 1
            assert json.loads(row.graph_json)["directionalSplit"] is True
            assert json.loads(row.summaries_json)[0]["bullets"] == ["a", "b"]
            assert row.created_at is not None
    finally:
        async with AsyncSessionLocal() as db:
            await delete_project_data(db, pid)
            proj = await db.get(DBProject, pid)
            if proj is not None:
                await db.delete(proj)
                await db.commit()


async def test_delete_project_data_removes_snapshots():
    async with AsyncSessionLocal() as db:
        proj = DBProject(name="snap-cascade", user_id=None)
        db.add(proj)
        await db.flush()
        pid = proj.id
        db.add_all(
            [
                DBGraphSnapshot(
                    project_id=pid, name=f"s{i}",
                    graph_json="{}", summaries_json="[]",
                )
                for i in range(2)
            ]
        )
        await db.commit()

    try:
        async with AsyncSessionLocal() as db:
            await delete_project_data(db, pid)

        async with AsyncSessionLocal() as db:
            remaining = (
                await db.execute(
                    select(DBGraphSnapshot).where(DBGraphSnapshot.project_id == pid)
                )
            ).scalars().all()
            assert remaining == []
    finally:
        async with AsyncSessionLocal() as db:
            proj = await db.get(DBProject, pid)
            if proj is not None:
                await db.delete(proj)
                await db.commit()
