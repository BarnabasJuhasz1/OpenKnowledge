from __future__ import annotations

from fastapi import Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBProject


async def require_project(
    project_id: int = Query(..., description="Active project id"),
    db: AsyncSession = Depends(get_db),
) -> int:
    """Validate that the given project exists and return its id.

    Used by every project-scoped endpoint so that data is always isolated to a
    single project.
    """
    result = await db.execute(select(DBProject).where(DBProject.id == project_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_id
