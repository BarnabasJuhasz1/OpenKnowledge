from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBProject, DBUser
from ..services.retrieval.persistence import delete_project_data
from .auth import optional_current_user
from .deps import get_owned_project

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    color: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str | None
    color: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    owner_id = user.id if user else None
    result = await db.execute(
        select(DBProject)
        .where(DBProject.user_id == owner_id)
        .order_by(DBProject.created_at.asc())
    )
    return result.scalars().all()


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(
    body: ProjectCreate,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Project name is required")
    project = DBProject(
        user_id=user.id if user else None,
        name=name,
        description=body.description,
        color=body.color,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: int,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_owned_project(project_id, user, db)


@router.put("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: int,
    body: ProjectUpdate,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await get_owned_project(project_id, user, db)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Project name cannot be empty")
        project.name = name
    if body.description is not None:
        project.description = body.description
    if body.color is not None:
        project.color = body.color
    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await get_owned_project(project_id, user, db)
    # Remove all data owned by the project, then the project itself.
    await delete_project_data(db, project_id)
    await db.delete(project)
    await db.commit()
