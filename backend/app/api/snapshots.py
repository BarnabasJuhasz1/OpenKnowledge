"""OK-Graph snapshot CRUD (okgraph-snapshots-02).

Snapshots persist the OK-Graph pipeline output (citation graph + Louvain +
cluster summaries) as two JSON blobs per row. Ownership is **transitive through
the project**: the path `project_id` is resolved with the ownership-aware
`get_owned_project` helper (404 — never 403 — for a project the caller can't
see), and every snapshot query is then scoped to that project. There is no
per-snapshot user check. Capped at 3 per project.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBGraphSnapshot, DBUser
from .auth import optional_current_user
from .deps import get_owned_project

router = APIRouter(prefix="/projects", tags=["snapshots"])

MAX_SNAPSHOTS_PER_PROJECT = 3


class SnapshotMeta(BaseModel):
    """List/create/rename response — never carries the blobs."""

    id: int
    name: str
    seed_id: str | None
    node_count: int | None
    cluster_count: int | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SnapshotDetail(SnapshotMeta):
    """Load response — adds the deserialized graph + summaries payloads."""

    graph: dict[str, Any]
    summaries: list[dict[str, Any]]


class SnapshotCreate(BaseModel):
    name: str
    graph: dict[str, Any]
    summaries: list[dict[str, Any]]


class SnapshotRename(BaseModel):
    name: str


def _cluster_count(summaries: list[dict[str, Any]]) -> int | None:
    """Distinct communities at the coarsest (top) level — the main-view cluster
    count. Level 0 is the finest partition, so the top level is the max level."""
    levels = [
        s["level"] for s in summaries
        if isinstance(s, dict) and s.get("level") is not None
    ]
    if not levels:
        return None
    top = max(levels)
    return len({s.get("community") for s in summaries if s.get("level") == top})


def _to_detail(snap: DBGraphSnapshot) -> SnapshotDetail:
    return SnapshotDetail(
        id=snap.id,
        name=snap.name,
        seed_id=snap.seed_id,
        node_count=snap.node_count,
        cluster_count=snap.cluster_count,
        created_at=snap.created_at,
        updated_at=snap.updated_at,
        graph=json.loads(snap.graph_json),
        summaries=json.loads(snap.summaries_json),
    )


async def _get_snapshot(
    project_id: int, snapshot_id: int, db: AsyncSession
) -> DBGraphSnapshot:
    """Load a snapshot that belongs to `project_id`, or 404.

    The caller must have already passed `get_owned_project`; this additionally
    guards against a valid snapshot id under a *different* project.
    """
    result = await db.execute(
        select(DBGraphSnapshot).where(
            DBGraphSnapshot.id == snapshot_id,
            DBGraphSnapshot.project_id == project_id,
        )
    )
    snap = result.scalar_one_or_none()
    if snap is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snap


@router.get("/{project_id}/snapshots", response_model=list[SnapshotMeta])
async def list_snapshots(
    project_id: int,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_owned_project(project_id, user, db)
    result = await db.execute(
        select(DBGraphSnapshot)
        .where(DBGraphSnapshot.project_id == project_id)
        .order_by(DBGraphSnapshot.created_at.asc())
    )
    return result.scalars().all()


@router.post(
    "/{project_id}/snapshots", response_model=SnapshotMeta, status_code=201
)
async def create_snapshot(
    project_id: int,
    body: SnapshotCreate,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_owned_project(project_id, user, db)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Snapshot name is required")

    used = (
        await db.execute(
            select(func.count())
            .select_from(DBGraphSnapshot)
            .where(DBGraphSnapshot.project_id == project_id)
        )
    ).scalar_one()
    if used >= MAX_SNAPSHOTS_PER_PROJECT:
        raise HTTPException(
            status_code=409, detail="Snapshot limit reached — delete one first"
        )

    snap = DBGraphSnapshot(
        project_id=project_id,
        name=name,
        seed_id=body.graph.get("seedId"),
        node_count=len(body.graph.get("nodes") or []),
        cluster_count=_cluster_count(body.summaries),
        graph_json=json.dumps(body.graph),
        summaries_json=json.dumps(body.summaries),
    )
    db.add(snap)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="A snapshot with that name already exists"
        )
    await db.refresh(snap)
    return snap


@router.get(
    "/{project_id}/snapshots/{snapshot_id}", response_model=SnapshotDetail
)
async def get_snapshot(
    project_id: int,
    snapshot_id: int,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_owned_project(project_id, user, db)
    snap = await _get_snapshot(project_id, snapshot_id, db)
    return _to_detail(snap)


@router.patch(
    "/{project_id}/snapshots/{snapshot_id}", response_model=SnapshotMeta
)
async def rename_snapshot(
    project_id: int,
    snapshot_id: int,
    body: SnapshotRename,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_owned_project(project_id, user, db)
    snap = await _get_snapshot(project_id, snapshot_id, db)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Snapshot name cannot be empty")
    snap.name = name
    snap.updated_at = datetime.now(timezone.utc)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="A snapshot with that name already exists"
        )
    await db.refresh(snap)
    return snap


@router.delete("/{project_id}/snapshots/{snapshot_id}", status_code=204)
async def delete_snapshot(
    project_id: int,
    snapshot_id: int,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_owned_project(project_id, user, db)
    snap = await _get_snapshot(project_id, snapshot_id, db)
    await db.delete(snap)
    await db.commit()
