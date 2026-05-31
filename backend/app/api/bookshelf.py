from __future__ import annotations

import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBBookshelfItem, DBPaperNote
from .deps import require_project

router = APIRouter(prefix="/bookshelf", tags=["bookshelf"])


class BookshelfCreate(BaseModel):
    paper_identifier: str
    title: str
    authors: list[str] = []
    year: int | None = None
    notes: str | None = None
    paper: dict | None = None  # full Paper snapshot for the detail view


class BookshelfUpdate(BaseModel):
    notes: str | None = None


class BookshelfOut(BaseModel):
    id: int
    paper_identifier: str
    title: str
    authors: list[str]
    year: int | None
    notes: str | None
    paper: dict | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @classmethod
    def from_db(cls, item: DBBookshelfItem) -> "BookshelfOut":
        authors = []
        if item.authors_json:
            try:
                authors = json.loads(item.authors_json)
            except (json.JSONDecodeError, TypeError):
                pass
        paper = None
        if item.paper_json:
            try:
                paper = json.loads(item.paper_json)
            except (json.JSONDecodeError, TypeError):
                pass
        return cls(
            id=item.id,
            paper_identifier=item.paper_identifier,
            title=item.title,
            authors=authors,
            year=item.year,
            notes=item.notes,
            paper=paper,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )


async def _upsert_note(
    db: AsyncSession, project_id: int, paper_identifier: str, notes: str | None
) -> None:
    """Persist a paper's notes independently of the bookshelf row."""
    result = await db.execute(
        select(DBPaperNote).where(
            DBPaperNote.project_id == project_id,
            DBPaperNote.paper_identifier == paper_identifier,
        )
    )
    note = result.scalar_one_or_none()
    if note:
        note.notes = notes
    else:
        db.add(DBPaperNote(
            project_id=project_id, paper_identifier=paper_identifier, notes=notes
        ))


@router.get("", response_model=list[BookshelfOut])
async def list_bookshelf(
    project_id: int = Depends(require_project), db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(DBBookshelfItem)
        .where(DBBookshelfItem.project_id == project_id)
        .order_by(DBBookshelfItem.created_at.desc())
    )
    return [BookshelfOut.from_db(i) for i in result.scalars().all()]


@router.post("", response_model=BookshelfOut, status_code=201)
async def add_to_bookshelf(
    body: BookshelfCreate,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(
        select(DBBookshelfItem).where(
            DBBookshelfItem.project_id == project_id,
            DBBookshelfItem.paper_identifier == body.paper_identifier,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Paper already in bookshelf")

    notes = body.notes
    if notes is None:
        # Restore any notes saved during a previous time this paper was on the shelf.
        prior = await db.execute(
            select(DBPaperNote).where(
                DBPaperNote.project_id == project_id,
                DBPaperNote.paper_identifier == body.paper_identifier,
            )
        )
        prior_note = prior.scalar_one_or_none()
        if prior_note:
            notes = prior_note.notes

    item = DBBookshelfItem(
        project_id=project_id,
        paper_identifier=body.paper_identifier,
        title=body.title,
        authors_json=json.dumps(body.authors),
        year=body.year,
        notes=notes,
        paper_json=json.dumps(body.paper) if body.paper is not None else None,
    )
    db.add(item)
    if notes is not None:
        await _upsert_note(db, project_id, body.paper_identifier, notes)
    await db.commit()
    await db.refresh(item)
    return BookshelfOut.from_db(item)


@router.put("/{item_id}", response_model=BookshelfOut)
async def update_bookshelf_item(
    item_id: int,
    body: BookshelfUpdate,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBBookshelfItem).where(
            DBBookshelfItem.id == item_id,
            DBBookshelfItem.project_id == project_id,
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Bookshelf item not found")
    if body.notes is not None:
        item.notes = body.notes
        await _upsert_note(db, project_id, item.paper_identifier, body.notes)
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return BookshelfOut.from_db(item)


@router.delete("/{item_id}", status_code=204)
async def remove_from_bookshelf(
    item_id: int,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBBookshelfItem).where(
            DBBookshelfItem.id == item_id,
            DBBookshelfItem.project_id == project_id,
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Bookshelf item not found")
    await db.delete(item)
    await db.commit()


@router.get("/check/{paper_identifier:path}")
async def check_bookshelf(
    paper_identifier: str,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DBBookshelfItem).where(
            DBBookshelfItem.project_id == project_id,
            DBBookshelfItem.paper_identifier == paper_identifier,
        )
    )
    item = result.scalar_one_or_none()
    return {"bookmarked": item is not None, "id": item.id if item else None}
