from __future__ import annotations

import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.retrieval.citgraph_builder import build_citation_graph, UpstreamError
from ..services.retrieval.demo_citgraph import DemoCitGraphStore
from ..services import archetype

router = APIRouter(prefix="/citgraph", tags=["citgraph"])


class CitGraphRequest(BaseModel):
    paper_id: str
    k: int = Field(default=1, ge=1, le=3)
    max_per_hop: int = Field(default=20, ge=1, le=50)


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


class CitGraphEdgeOut(BaseModel):
    source: str
    target: str


class CitGraphResponse(BaseModel):
    nodes: list[CitGraphNodeOut]
    edges: list[CitGraphEdgeOut]
    seed_id: str


def _to_response(result) -> CitGraphResponse:
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
async def build_graph(body: CitGraphRequest):
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
    return _to_response(result)


@router.post("/demo/build", response_model=CitGraphResponse)
async def build_graph_demo(body: CitGraphRequest):
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
    return _to_response(result)
