"""Scoring API endpoints.

POST /api/score-papers  — Bulk-score all papers in the DB with given weights
GET  /api/paper-score/{title} — Single paper breakdown with fuzzy title matching
"""
from __future__ import annotations

import json

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from rapidfuzz import fuzz, process
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBPaper, DBPaperAuthor, DBAuthor
from .deps import require_project
from ..models.paper import (
    Author,
    PaperScoreResponse,
    ScoreBreakdown,
    ScorePapersRequest,
    ScorePapersResponse,
    ScoredPaper,
)
from ..services.scorer import score_paper_single, score_papers_bulk

router = APIRouter(prefix="/score", tags=["scoring"])


def _authors_from_db(db_paper: DBPaper) -> list[Author]:
    """Extract Author list from a loaded DBPaper (with selectin authors)."""
    authors: list[Author] = []
    for pa in sorted(db_paper.authors, key=lambda a: a.position):
        authors.append(Author(
            name=pa.author.name,
            openalex_id=pa.author.openalex_id,
            orcid=pa.author.orcid,
        ))
    return authors


@router.post("/score-papers", response_model=ScorePapersResponse)
async def score_papers(
    request: ScorePapersRequest,
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
) -> ScorePapersResponse:
    """Bulk-score the active project's papers with the given weights."""
    result = await db.execute(
        select(DBPaper).where(DBPaper.project_id == project_id)
    )
    db_papers: list[DBPaper] = list(result.scalars().all())

    if not db_papers:
        return ScorePapersResponse(papers=[], total_scored=0)

    # Build DataFrame
    rows = []
    for p in db_papers:
        rows.append({
            "title": p.title,
            "year": p.year,
            "journal": p.journal,
            "venue": p.venue,
            "citation_count": p.citation_count,
            "has_public_code": p.has_public_code,
            "is_peer_reviewed": p.is_peer_reviewed,
            "has_dataset": p.has_dataset,
            "repo_stars": p.repo_stars,
            "_db_id": p.id,
        })

    df = pd.DataFrame(rows)
    weights = request.weights.model_dump()
    scored_df = score_papers_bulk(df, weights)

    # Limit results
    top_df = scored_df.head(request.limit)

    # Map DB id → DBPaper for author lookup
    paper_map = {p.id: p for p in db_papers}

    scored_papers: list[ScoredPaper] = []
    for _, row in top_df.iterrows():
        db_paper = paper_map.get(row["_db_id"])
        authors = _authors_from_db(db_paper) if db_paper else []
        scored_papers.append(ScoredPaper(
            title=row["title"],
            authors=authors,
            year=row.get("year"),
            journal=row.get("journal"),
            venue=row.get("venue"),
            citation_count=row.get("citation_count"),
            has_public_code=row.get("has_public_code"),
            is_peer_reviewed=row.get("is_peer_reviewed"),
            has_dataset=row.get("has_dataset", False),
            repo_stars=row.get("repo_stars", 0),
            ok_score=row["ok_score"],
        ))

    return ScorePapersResponse(
        papers=scored_papers,
        total_scored=len(df),
    )


@router.get("/paper-score/{title}", response_model=PaperScoreResponse)
async def paper_score(
    title: str,
    w_c: float = Query(1.0),
    w_code: float = Query(1.0),
    w_peer: float = Query(1.0),
    w_data: float = Query(1.0),
    w_stars: float = Query(1.0),
    project_id: int = Depends(require_project),
    db: AsyncSession = Depends(get_db),
) -> PaperScoreResponse:
    """Score a single paper by fuzzy title match and return a breakdown."""
    result = await db.execute(
        select(DBPaper).where(DBPaper.project_id == project_id)
    )
    db_papers: list[DBPaper] = list(result.scalars().all())

    if not db_papers:
        raise HTTPException(status_code=404, detail="No papers in database")

    # Fuzzy match
    titles = [p.title for p in db_papers]
    match = process.extractOne(title, titles, scorer=fuzz.WRatio)

    if match is None or match[1] < 50:
        raise HTTPException(
            status_code=404,
            detail=f"No paper found matching '{title}'",
        )

    matched_title, score, idx = match
    db_paper = db_papers[idx]

    weights = {
        "w_c": w_c,
        "w_code": w_code,
        "w_peer": w_peer,
        "w_data": w_data,
        "w_stars": w_stars,
    }

    paper_data = {
        "citation_count": db_paper.citation_count,
        "has_public_code": db_paper.has_public_code,
        "is_peer_reviewed": db_paper.is_peer_reviewed,
        "has_dataset": db_paper.has_dataset,
        "repo_stars": db_paper.repo_stars,
    }

    result_data = score_paper_single(paper_data, weights)

    return PaperScoreResponse(
        title=db_paper.title,
        ok_score=result_data["total_score"],
        breakdown=ScoreBreakdown(**result_data["breakdown"]),
    )
