from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.database import get_db
from ..db.orm_models import DBPaper, DBUser
from ..services.retrieval.citgraph_builder import build_citation_graph, UpstreamError, explore_citation_graph
from ..services.retrieval.demo_citgraph import DemoCitGraphStore
from ..services import archetype
from .auth import optional_current_user
from .deps import get_owned_project

router = APIRouter(prefix="/citgraph", tags=["citgraph"])


class CitGraphRequest(BaseModel):
    paper_id: str
    k: int = Field(default=1, ge=1, le=10)
    max_per_hop: int = Field(default=20, ge=1, le=100000)


class GraphNodeFilter(BaseModel):
    """Metadata constraints enforced on EVERY node during expansion (seeds + neighbours).

    Only fields available on OpenSearch-hydrated nodes live here. Code-availability,
    peer-reviewed status, and archetype are intentionally absent — they aren't known
    for expanded nodes, so the client pre-filters seeds for those (pass-through
    decision), and expanded nodes are never dropped for missing that data.
    """
    year_min: int | None = None
    year_max: int | None = None
    # Disconnected year windows (each [lo, hi], inclusive). When set, a node passes
    # the year constraint iff its year falls in ANY interval — used by the "around
    # seed papers" default build mode, where multiple seeds yield disjoint windows
    # (e.g. seeds 1990 & 2010 -> [[1988, 1992], [2008, 2012]]). Supersedes
    # year_min/year_max when present.
    year_intervals: list[list[int]] | None = None
    citation_min: int | None = None
    citation_max: int | None = None
    open_access_only: bool = False
    fields: list[str] = Field(default_factory=list)  # empty => no field-of-study filter


class CitGraphExploreRequest(BaseModel):
    paper_ids: list[str]
    direction: str  # 'past', 'future', 'both'
    include_non_matching: bool = True
    keywords: list[str] = Field(default_factory=list)
    # Boolean title+abstract query (AND/OR/NOT, "phrases", parens) — the same engine as
    # search. When set it supersedes the legacy `keywords`/`include_non_matching` filter
    # and gates every expanded node; non-matching neighbours are never added or expanded.
    boolean_query: str | None = None
    # Metadata constraints applied to every node during expansion (see GraphNodeFilter).
    node_filter: GraphNodeFilter | None = None
    k: int = Field(default=1, ge=1, le=10)
    max_per_hop: int | None = Field(default=None, ge=1, le=100000)
    # Of the references/citers fetched per paper, keep only the top-K by ok-score
    # per hop level. None/null = keep all.
    top_k_per_paper: list[int | None] | None = Field(default=None)
    # When true, keep only S2 "highly influential" citation edges: non-influential
    # edges (and the papers they would have introduced) are dropped before
    # traversal continues. Honoured by the hosted `/explore` path only; the demo
    # corpus has no per-edge influence flag, so `/demo/explore` ignores it.
    influential_only: bool = False
    # v2 ("direction-pure cones") construction. When true AND direction == 'both',
    # the graph is built as the union of a pure future cone (citations only, every
    # hop) and a pure past cone (references only, every hop) — no node is reached by
    # a path that mixes citation and reference hops. False (default) = v1, the mixed
    # K-hop neighbourhood. No effect for single-direction builds.
    directional_split: bool = False




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
    is_influential: bool = False


class CitGraphResponse(BaseModel):
    nodes: list[CitGraphNodeOut]
    edges: list[CitGraphEdgeOut]
    seed_id: str


async def _enrichment_map(
    nodes, project_id: int | None, user: DBUser | None, db: AsyncSession
) -> dict[str, dict]:
    """Map node paper_id -> ok-score enrichment fields, joining live citgraph
    nodes to the active project's stored papers by DOI then arXiv id.

    Returns an empty map when no project is active so the live, project-agnostic
    build keeps working; unmatched nodes simply get neutral defaults downstream.
    When a project_id is given it must be one the caller can access (else 404),
    so enrichment can't read another user's papers.
    """
    if project_id is None:
        return {}
    await get_owned_project(project_id, user, db)
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
            CitGraphEdgeOut(source=e.source, target=e.target, is_influential=e.is_influential)
            for e in result.edges
        ],
        seed_id=result.seed_id,
    )


@router.post("/build", response_model=CitGraphResponse)
async def build_graph(
    body: CitGraphRequest,
    project_id: int | None = Query(default=None),
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await build_citation_graph(
            paper_id=body.paper_id,
            k=body.k,
            max_per_hop=body.max_per_hop,
        )
    except UpstreamError as e:
        # Transient hosted-backend failure (OpenSearch / BigQuery) — not a missing paper.
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to build graph: {e}")

    if not result.nodes:
        raise HTTPException(status_code=404, detail="Paper not found or no data available")

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, user, db)
    return _to_response(result, enrich)


@router.post("/demo/build", response_model=CitGraphResponse)
async def build_graph_demo(
    body: CitGraphRequest,
    project_id: int | None = Query(default=None),
    user: DBUser | None = Depends(optional_current_user),
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
    enrich = await _enrichment_map(result.nodes, project_id, user, db)
    return _to_response(result, enrich)


@router.post("/explore", response_model=CitGraphResponse)
async def explore_graph(
    body: CitGraphExploreRequest,
    project_id: int | None = Query(default=None),
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await explore_citation_graph(
            seeds=body.paper_ids,
            direction=body.direction,
            include_non_matching=body.include_non_matching,
            keywords=body.keywords,
            boolean_query=body.boolean_query,
            node_filter=body.node_filter,
            k=body.k,
            max_per_hop=body.max_per_hop,
            top_k_per_paper=body.top_k_per_paper,
            influential_only=body.influential_only,
            directional_split=body.directional_split,
        )
    except UpstreamError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to explore graph: {e}")

    if not result.nodes:
        raise HTTPException(status_code=404, detail="No papers found or no data available")

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, user, db)
    return _to_response(result, enrich)


@router.post("/demo/explore", response_model=CitGraphResponse)
async def explore_graph_demo(
    body: CitGraphExploreRequest,
    project_id: int | None = Query(default=None),
    user: DBUser | None = Depends(optional_current_user),
    db: AsyncSession = Depends(get_db),
):
    store = DemoCitGraphStore.get()
    try:
        result = await store.explore(
            seeds=body.paper_ids,
            direction=body.direction,
            include_non_matching=body.include_non_matching,
            keywords=body.keywords,
            boolean_query=body.boolean_query,
            node_filter=body.node_filter,
            k=body.k,
            max_per_hop=body.max_per_hop,
            top_k_per_paper=body.top_k_per_paper,
            directional_split=body.directional_split,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to explore graph: {e}")

    if not result.nodes:
        raise HTTPException(
            status_code=404, detail="No papers found in demo dataset"
        )

    await archetype.classify_citgraph_nodes(result.nodes)
    enrich = await _enrichment_map(result.nodes, project_id, user, db)
    return _to_response(result, enrich)
