"""Portfolio-level dashboard statistics.

The Dashboard tab is global (not scoped to a single project), so this endpoint
aggregates across every project the user owns: headline KPIs, a per-project
comparison breakdown, and a merged recent-activity feed. Everything is computed
with aggregate queries so the payload stays small even for large libraries.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import (
    DBBookshelfItem,
    DBPaper,
    DBProject,
    DBRetrievalJob,
    DBShelfItem,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

# How many entries to surface in the recent-activity feed.
_ACTIVITY_LIMIT = 15


class DashboardTotals(BaseModel):
    projects: int
    library_papers: int
    saved_searches: int
    retrieved_papers: int
    searches_run: int
    papers_added_this_week: int


class DashboardProjectStat(BaseModel):
    id: int
    name: str
    color: str | None
    library_papers: int
    saved_searches: int
    retrieved_papers: int
    searches_run: int
    created_at: datetime
    last_activity: datetime


class DashboardActivityItem(BaseModel):
    kind: str  # library_add | saved_search | search_run | project_created
    project_id: int
    project_name: str
    project_color: str | None
    title: str
    timestamp: datetime


class DashboardStatsOut(BaseModel):
    totals: DashboardTotals
    projects: list[DashboardProjectStat]
    recent_activity: list[DashboardActivityItem]


def _as_utc(value: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; treat them as UTC for stable sorting."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def _counts_by_project(db: AsyncSession, column, table) -> dict[int, int]:
    """Return {project_id: row_count} for the given table."""
    result = await db.execute(
        select(column, func.count()).group_by(column)
    )
    return {pid: count for pid, count in result.all()}


@router.get("/stats", response_model=DashboardStatsOut)
async def dashboard_stats(db: AsyncSession = Depends(get_db)) -> DashboardStatsOut:
    projects = (
        await db.execute(select(DBProject).order_by(DBProject.created_at.asc()))
    ).scalars().all()
    project_map = {p.id: p for p in projects}

    # --- Per-project counts (one grouped query each) ------------------------
    library_counts = await _counts_by_project(
        db, DBBookshelfItem.project_id, DBBookshelfItem
    )
    shelf_counts = await _counts_by_project(db, DBShelfItem.project_id, DBShelfItem)
    paper_counts = await _counts_by_project(db, DBPaper.project_id, DBPaper)
    job_counts = await _counts_by_project(db, DBRetrievalJob.project_id, DBRetrievalJob)

    # Latest activity timestamp seen per project, across all item tables.
    last_activity: dict[int, datetime] = {}

    def _bump(pid: int, ts: datetime | None) -> None:
        ts = _as_utc(ts)
        if ts is None:
            return
        current = last_activity.get(pid)
        if current is None or ts > current:
            last_activity[pid] = ts

    for pid, ts in (
        await db.execute(
            select(DBBookshelfItem.project_id, func.max(DBBookshelfItem.updated_at))
            .group_by(DBBookshelfItem.project_id)
        )
    ).all():
        _bump(pid, ts)
    for pid, ts in (
        await db.execute(
            select(DBShelfItem.project_id, func.max(DBShelfItem.last_used_at))
            .group_by(DBShelfItem.project_id)
        )
    ).all():
        _bump(pid, ts)
    for pid, ts in (
        await db.execute(
            select(DBRetrievalJob.project_id, func.max(DBRetrievalJob.created_at))
            .group_by(DBRetrievalJob.project_id)
        )
    ).all():
        _bump(pid, ts)

    project_stats: list[DashboardProjectStat] = []
    for p in projects:
        created = _as_utc(p.created_at) or datetime.now(timezone.utc)
        updated = _as_utc(p.updated_at) or created
        project_stats.append(
            DashboardProjectStat(
                id=p.id,
                name=p.name,
                color=p.color,
                library_papers=library_counts.get(p.id, 0),
                saved_searches=shelf_counts.get(p.id, 0),
                retrieved_papers=paper_counts.get(p.id, 0),
                searches_run=job_counts.get(p.id, 0),
                created_at=created,
                last_activity=last_activity.get(p.id, updated),
            )
        )

    # --- Totals -------------------------------------------------------------
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    added_this_week = (
        await db.execute(
            select(func.count()).select_from(DBBookshelfItem).where(
                DBBookshelfItem.created_at >= week_ago
            )
        )
    ).scalar_one()

    totals = DashboardTotals(
        projects=len(projects),
        library_papers=sum(library_counts.values()),
        saved_searches=sum(shelf_counts.values()),
        retrieved_papers=sum(paper_counts.values()),
        searches_run=sum(job_counts.values()),
        papers_added_this_week=int(added_this_week or 0),
    )

    # --- Recent activity feed ----------------------------------------------
    activity: list[DashboardActivityItem] = []

    def _add(kind: str, pid: int, title: str, ts: datetime | None) -> None:
        proj = project_map.get(pid)
        ts = _as_utc(ts)
        if proj is None or ts is None:
            return
        activity.append(
            DashboardActivityItem(
                kind=kind,
                project_id=pid,
                project_name=proj.name,
                project_color=proj.color,
                title=title,
                timestamp=ts,
            )
        )

    for item in (
        await db.execute(
            select(DBBookshelfItem)
            .order_by(DBBookshelfItem.created_at.desc())
            .limit(_ACTIVITY_LIMIT)
        )
    ).scalars().all():
        _add("library_add", item.project_id, item.title, item.created_at)

    for item in (
        await db.execute(
            select(DBShelfItem)
            .order_by(DBShelfItem.created_at.desc())
            .limit(_ACTIVITY_LIMIT)
        )
    ).scalars().all():
        _add("saved_search", item.project_id, item.label or item.query_text, item.created_at)

    for job in (
        await db.execute(
            select(DBRetrievalJob)
            .order_by(DBRetrievalJob.created_at.desc())
            .limit(_ACTIVITY_LIMIT)
        )
    ).scalars().all():
        _add("search_run", job.project_id, job.query_text or "Search", job.created_at)

    for p in projects:
        _add("project_created", p.id, p.name, p.created_at)

    activity.sort(key=lambda a: a.timestamp, reverse=True)

    return DashboardStatsOut(
        totals=totals,
        projects=project_stats,
        recent_activity=activity[:_ACTIVITY_LIMIT],
    )
