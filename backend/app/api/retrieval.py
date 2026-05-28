import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.paper import SearchRequest, SearchResponse, BackgroundProgress
from ..services.retrieval import fetcher
from ..services.retrieval.persistence import flush_all, upsert_papers, save_job
from ..services.retrieval.background import background_manager
from ..services.retrieval.fetcher import _build_adapters
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
        initial_counts = {}
        queries_used = {}

        async for event in fetcher.search_stream(request):
            sources_queried.append(event.source)
            if event.failed:
                sources_failed.append(event.source)
            else:
                all_papers.extend(event.papers)
                initial_counts[event.source] = len(event.papers)
            
            queries_used[event.source] = event.query_used

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

        background_job_id = None
        if (
            request.continue_in_background
            and request.max_total_results is not None
            and request.max_total_results > request.max_initial_results
        ):
            bg_adapters = _build_adapters(request.databases)
            bg_adapters = [a for a in bg_adapters if a.name in initial_counts and a.name not in sources_failed]
            if bg_adapters:
                job = background_manager.create_job()
                background_job_id = job.job_id
                background_manager.start_background_fetch(
                    job=job,
                    adapters=bg_adapters,
                    queries=queries_used,
                    initial_counts=initial_counts,
                    max_results_per_adapter=request.max_total_results,
                )

        # Final done event
        done_payload = json.dumps({
            "total_found": len(all_papers),
            "sources_queried": sources_queried,
            "sources_failed": sources_failed,
            "background_job_id": background_job_id,
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


@router.get("/background/{job_id}")
async def background_progress(job_id: str) -> StreamingResponse:
    """SSE endpoint that streams progress of a background fetch job."""
    job = background_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Background job not found")

    async def event_generator():
        while True:
            try:
                progress: BackgroundProgress = await asyncio.wait_for(
                    job.progress_queue.get(),
                    timeout=300.0,
                )
                payload = progress.model_dump_json()
                yield f"data: {payload}\n\n"

                if progress.is_complete:
                    # Send final papers if any were collected
                    if job.papers:
                        papers_payload = json.dumps({
                            "papers": [p.model_dump(mode="json") for p in job.papers],
                            "total_background": len(job.papers),
                        })
                        yield f"event: papers\ndata: {papers_payload}\n\n"
                    break
            except asyncio.TimeoutError:
                # Send keepalive
                yield f": keepalive\n\n"

    import asyncio
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.delete("/background/{job_id}")
async def cancel_background(job_id: str):
    """Cancel a running background fetch job."""
    success = background_manager.cancel_job(job_id)
    if not success:
        raise HTTPException(status_code=404, detail="Background job not found")
    return {"status": "cancelled", "job_id": job_id}
