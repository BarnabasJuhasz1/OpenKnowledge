from __future__ import annotations

from fastapi import Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBProject, DBUser
from .auth import optional_current_user


def _can_access(proj: DBProject, user: DBUser | None) -> bool:
    """A user owns a project iff its user_id matches theirs.

    Signed out (user is None) maps to the legacy/guest bucket: only projects
    with user_id IS NULL are accessible.
    """
    return proj.user_id == (user.id if user else None)


async def get_owned_project(
    project_id: int, user: DBUser | None, db: AsyncSession
) -> DBProject:
    """Load a project the caller may access, or raise 404.

    Shared by `require_project` and the project CRUD endpoints so ownership is
    enforced identically everywhere. Always 404 (never 403) so existence of
    another user's project isn't leaked.
    """
    result = await db.execute(select(DBProject).where(DBProject.id == project_id))
    proj = result.scalar_one_or_none()
    if proj is None or not _can_access(proj, user):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


async def require_project(
    project_id: int = Query(..., description="Active project id"),
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
) -> int:
    """Validate that the project exists, is accessible to the caller, and return its id.

    Used by every project-scoped endpoint so that data is always isolated to a
    single project AND to its owner (authenticated → own projects;
    unauthenticated → the `user_id IS NULL` guest bucket).
    """
    await get_owned_project(project_id, user, db)
    return project_id
