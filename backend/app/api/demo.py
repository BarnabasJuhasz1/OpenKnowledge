from fastapi import APIRouter, HTTPException
from ..models.paper import SearchRequest, SearchResponse
from ..services.retrieval.demo import DemoDataStore

router = APIRouter(prefix="/retrieval/demo", tags=["demo"])


@router.post("/search", response_model=SearchResponse)
async def demo_search(request: SearchRequest) -> SearchResponse:
    if not request.keywords:
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    store = DemoDataStore.get()
    papers = store.search(request.keywords, limit=None)

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
