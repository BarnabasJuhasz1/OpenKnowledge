from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBShelfItem
from .deps import require_project

router = APIRouter(prefix="/shelf", tags=["shelf"])


class ShelfItemCreate(BaseModel):
    query_text: str
    label: str | None = None


class ShelfItemUpdate(BaseModel):
    query_text: str | None = None
    label: str | None = None


class ShelfItemOut(BaseModel):
    id: int
    query_text: str
    label: str | None
    created_at: datetime
    last_used_at: datetime
    use_count: int

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ShelfItemOut])
async def list_shelf(
    project_id: int = Depends(require_project), db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(DBShelfItem)
        .where(DBShelfItem.project_id == project_id)
        .order_by(DBShelfItem.last_used_at.desc())
    )
    return result.scalars().all()


@router.get("/recent", response_model=list[ShelfItemOut])
async def recent_shelf(
    limit: int = 5,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBShelfItem)
        .where(DBShelfItem.project_id == project_id)
        .order_by(DBShelfItem.last_used_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.post("", response_model=ShelfItemOut, status_code=201)
async def create_shelf_item(
    body: ShelfItemCreate,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    query_text = body.query_text.strip()
    existing = await db.execute(
        select(DBShelfItem).where(
            DBShelfItem.project_id == project_id,
            DBShelfItem.query_text == query_text,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Query already on shelf")
    item = DBShelfItem(
        project_id=project_id,
        query_text=query_text,
        label=body.label or query_text,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


@router.put("/{item_id}", response_model=ShelfItemOut)
async def update_shelf_item(
    item_id: int,
    body: ShelfItemUpdate,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBShelfItem).where(
            DBShelfItem.id == item_id, DBShelfItem.project_id == project_id
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Shelf item not found")
    if body.query_text is not None:
        item.query_text = body.query_text
    if body.label is not None:
        item.label = body.label
    await db.commit()
    await db.refresh(item)
    return item


@router.put("/{item_id}/use", response_model=ShelfItemOut)
async def use_shelf_item(
    item_id: int,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBShelfItem).where(
            DBShelfItem.id == item_id, DBShelfItem.project_id == project_id
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Shelf item not found")
    item.last_used_at = datetime.now(timezone.utc)
    item.use_count += 1
    await db.commit()
    await db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
async def delete_shelf_item(
    item_id: int,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBShelfItem).where(
            DBShelfItem.id == item_id, DBShelfItem.project_id == project_id
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Shelf item not found")
    await db.delete(item)
    await db.commit()
