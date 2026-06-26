"""DEPRECATED — demo mode.

Demo mode is no longer offered in the UI (Semantic Scholar is the only selectable mode);
this router is retained for reference only. Do not build new features on it.
"""
from fastapi import APIRouter, HTTPException
from ..models.paper import SearchRequest, SearchResponse
from ..services.retrieval.demo import DemoDataStore
from ..services import archetype

router = APIRouter(prefix="/retrieval/demo", tags=["demo (deprecated)"])


@router.post("/search", response_model=SearchResponse, deprecated=True)
async def demo_search(request: SearchRequest) -> SearchResponse:
    """DEPRECATED: bundled-dataset demo search. Use ``/retrieval/scholar/search/page``."""
    if not request.keywords:
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    store = DemoDataStore.get()
    papers = store.search(request.keywords, limit=None)
    await archetype.classify_papers(papers)

    return SearchResponse(
        papers=papers,
        total_found=len(papers),
        total_available=len(papers),
        sources_queried=["demo"],
        sources_failed=[],
        queries_used={"demo": " ".join(request.keywords)},
        deduplication_removed=0,
        background_job_id=None,
    )
