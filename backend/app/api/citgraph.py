from __future__ import annotations

import os
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBPaper
from ..services.retrieval.citgraph_builder import build_citation_graph, UpstreamError, explore_citation_graph
from ..services.retrieval.demo_citgraph import DemoCitGraphStore
from ..services import archetype

router = APIRouter(prefix="/citgraph", tags=["citgraph"])


class CitGraphRequest(BaseModel):
    paper_id: str
    k: int = Field(default=1, ge=1, le=10)
    max_per_hop: int = Field(default=20, ge=1, le=100000)


class CitGraphExploreRequest(BaseModel):
    paper_ids: list[str]
    direction: str  # 'past', 'future', 'both'
    include_non_matching: bool = True
    keywords: list[str] = Field(default_factory=list)
    k: int = Field(default=1, ge=1, le=10)
    max_per_hop: int = Field(default=20, ge=1, le=100000)


class CitGraphNodeOut(BaseModel):
    paper_id: str
    doi: str | None = None
    arxiv_id: str | None = None
    title: str
    abstract: str | None = None
    year: int | None = None
    citation_count: int | None = None
    reference_count: int | None = None
    authors: list[str]
    journal: str | None = None
    is_open_access: bool = False
    pdf_url: str | None = None
    fields_of_study: list[str]
    hop: int
    predicted_main_archetype: str | None = None
    predicted_second_tier_archetype: str | None = None
    # Project ok-score enrichment (populated when the node matches a paper in the
    # active project's DB; neutral defaults otherwise). The frontend combines
    # these with the project's weights to compute the ok-score.
    has_public_code: bool | None = None
    is_peer_reviewed: bool | None = None
    has_dataset: bool = False
    repo_stars: int = 0


class CitGraphEdgeOut(BaseModel):
    source: str
    target: str


class CitGraphResponse(BaseModel):
    nodes: list[CitGraphNodeOut]
    edges: list[CitGraphEdgeOut]
    seed_id: str


async def _enrichment_map(
    nodes, project_id: int | None, db: AsyncSession
) -> dict[str, dict]:
    """Map node paper_id -> ok-score enrichment fields, joining live citgraph
    nodes to the active project's stored papers by DOI then arXiv id.

    Returns an empty map when no project is active so the live, project-agnostic
    build keeps working; unmatched nodes simply get neutral defaults downstream.
    """
    if project_id is None:
        return {}
    result = await db.execute(
        select(DBPaper).where(DBPaper.project_id == project_id)
    )
    papers = list(result.scalars().all())
    by_doi: dict[str, DBPaper] = {}
    by_arxiv: dict[str, DBPaper] = {}
    for p in papers:
        if p.doi:
            by_doi[p.doi.lower()] = p
        if p.arxiv_id:
            by_arxiv[p.arxiv_id.lower()] = p

    out: dict[str, dict] = {}
    for n in nodes:
        match = None
        if n.doi and n.doi.lower() in by_doi:
            match = by_doi[n.doi.lower()]
        elif n.arxiv_id and n.arxiv_id.lower() in by_arxiv:
            match = by_arxiv[n.arxiv_id.lower()]
        if match is not None:
            out[n.paper_id] = {
                "has_public_code": match.has_public_code,
                "is_peer_reviewed": match.is_peer_reviewed,
                "has_dataset": match.has_dataset,
                "repo_stars": match.repo_stars,
            }
    return out


def _to_response(result, enrich: dict[str, dict] | None = None) -> CitGraphResponse:
    enrich = enrich or {}
    return CitGraphResponse(
        nodes=[
            CitGraphNodeOut(
                paper_id=n.paper_id,
                doi=n.doi,
                arxiv_id=n.arxiv_id,
                title=n.title,
                abstract=n.abstract,
                year=n.year,
                citation_count=n.citation_count,
                reference_count=n.reference_count,
                authors=n.authors,
                journal=n.journal,
                is_open_access=n.is_open_access,
                pdf_url=n.pdf_url,
                fields_of_study=n.fields_of_study,
                hop=n.hop,
                predicted_main_archetype=getattr(n, "predicted_main_archetype", None),
                predicted_second_tier_archetype=getattr(n, "predicted_second_tier_archetype", None),
                has_public_code=enrich.get(n.paper_id, {}).get("has_public_code"),
                is_peer_reviewed=enrich.get(n.paper_id, {}).get("is_peer_reviewed"),
                has_dataset=enrich.get(n.paper_id, {}).get("has_dataset", False),
                repo_stars=enrich.get(n.paper_id, {}).get("repo_stars", 0),
            )
            for n in result.nodes
        ],
        edges=[
            CitGraphEdgeOut(source=e.source, target=e.target)
            for e in result.edges
        ],
        seed_id=result.seed_id,
    )


@router.post("/build", response_model=CitGraphResponse)
async def build_graph(
    body: CitGraphRequest,
    project_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    api_key = os.getenv("SEMANTIC_SCHOLAR_API_KEY")
    try:
        result = await build_citation_graph(
            paper_id=body.paper_id,
            k=body.k,
            max_per_hop=body.max_per_hop,
            api_key=api_key,
        )
    except UpstreamError as e:
        # Transient upstream failure (rate limit / network) — not a missing paper.
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to build graph: {e}")

    if not result.nodes:
        raise HTTPException(status_code=404, detail="Paper not found or no data available")

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, db)
    return _to_response(result, enrich)


@router.post("/demo/build", response_model=CitGraphResponse)
async def build_graph_demo(
    body: CitGraphRequest,
    project_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Build a citation graph from the local demo dataset (no external calls)."""
    store = DemoCitGraphStore.get()
    try:
        result = await store.build(
            seed=body.paper_id, k=body.k, max_per_hop=body.max_per_hop
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to build graph: {e}")

    if not result.nodes:
        raise HTTPException(
            status_code=404, detail="Paper not found in demo dataset"
        )

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, db)
    return _to_response(result, enrich)


@router.post("/explore", response_model=CitGraphResponse)
async def explore_graph(
    body: CitGraphExploreRequest,
    project_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    api_key = os.getenv("SEMANTIC_SCHOLAR_API_KEY")
    try:
        result = await explore_citation_graph(
            seeds=body.paper_ids,
            direction=body.direction,
            include_non_matching=body.include_non_matching,
            keywords=body.keywords,
            k=body.k,
            max_per_hop=body.max_per_hop,
            api_key=api_key,
        )
    except UpstreamError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to explore graph: {e}")

    if not result.nodes:
        raise HTTPException(status_code=404, detail="No papers found or no data available")

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, db)
    return _to_response(result, enrich)


@router.post("/demo/explore", response_model=CitGraphResponse)
async def explore_graph_demo(
    body: CitGraphExploreRequest,
    project_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    store = DemoCitGraphStore.get()
    try:
        result = await store.explore(
            seeds=body.paper_ids,
            direction=body.direction,
            include_non_matching=body.include_non_matching,
            keywords=body.keywords,
            k=body.k,
            max_per_hop=body.max_per_hop,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to explore graph: {e}")

    if not result.nodes:
        raise HTTPException(
            status_code=404, detail="No papers found in demo dataset"
        )

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, db)
    return _to_response(result, enrich)
