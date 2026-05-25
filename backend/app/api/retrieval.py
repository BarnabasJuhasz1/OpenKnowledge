import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.paper import SearchRequest, SearchResponse
from ..services.retrieval import fetcher
from ..services.retrieval.persistence import flush_all, upsert_papers, save_job
from ..db.database import get_db

router = APIRouter(prefix="/retrieval", tags=["retrieval"])


@router.post("/search", response_model=SearchResponse)
async def search_papers(
    request: SearchRequest,
    db: AsyncSession = Depends(get_db),
) -> SearchResponse:
    if not request.keywords:
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    response = await fetcher.search(request)

    # Flush old data and persist fresh results
    await flush_all(db)
    await upsert_papers(db, response.papers)
    await save_job(
        db,
        keywords=request.keywords,
        databases=response.sources_queried,
        n_results=response.total_found,
        failed_sources=response.sources_failed,
    )

    return response


@router.post("/search/stream")
async def search_papers_stream(
    request: SearchRequest,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    if not request.keywords:
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    async def event_generator():
        all_papers = []
        sources_queried = []
        sources_failed = []

        async for event in fetcher.search_stream(request):
            sources_queried.append(event.source)
            if event.failed:
                sources_failed.append(event.source)
            else:
                all_papers.extend(event.papers)

            payload = event.model_dump_json()
            yield f"data: {payload}\n\n"

        # Persist after all sources complete
        await flush_all(db)
        await upsert_papers(db, all_papers)
        await save_job(
            db,
            keywords=request.keywords,
            databases=sources_queried,
            n_results=len(all_papers),
            failed_sources=sources_failed,
        )

        # Final done event
        done_payload = json.dumps({
            "total_found": len(all_papers),
            "sources_queried": sources_queried,
            "sources_failed": sources_failed,
        })
        yield f"event: done\ndata: {done_payload}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
