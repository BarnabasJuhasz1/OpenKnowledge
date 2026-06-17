"""Semantic Scholar mode: boolean full-text search over a dedicated OpenSearch index.

Mirrors the demo endpoint's shape (`SearchRequest` -> `SearchResponse`) so the frontend
can swap modes with no schema changes. The OpenSearch index is populated from the BigQuery
`papers_search` export by ``scripts/ingest_opensearch.py``.

Two read paths:
  * ``POST /search``        — buffered ``SearchResponse`` (fine for the capped/top-N case).
  * ``POST /search/stream`` — NDJSON stream off ``engine.iter_search``, for result sets too
    large to hold in memory (unbounded ``OPENSEARCH_RESULT_LIMIT``). Papers are emitted as
    they scroll out of OpenSearch, so neither the server nor the client buffers millions of
    rows at once.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import anyio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..models.paper import SearchRequest, SearchResponse
from ..services import archetype
from ..services.retrieval.boolean_query import BooleanQueryError, compile_to_opensearch
from ..services.retrieval.opensearch_search import (
    OpenSearchError,
    OpenSearchNotConfiguredError,
    get_engine,
)

router = APIRouter(prefix="/retrieval/scholar", tags=["scholar"])

# Papers are pulled (and archetype-classified) in batches of this size while streaming, so
# memory stays bounded regardless of how many million the query matches.
_STREAM_BATCH = 500


def _boolean_source(request: SearchRequest) -> str:
    """The boolean query string to run: the user's raw query, or AND-joined keywords."""
    if request.raw_query and request.raw_query.strip():
        return request.raw_query.strip()
    return " AND ".join(f'"{k}"' if " " in k else k for k in request.keywords)


@router.post("/search", response_model=SearchResponse)
async def scholar_search(request: SearchRequest) -> SearchResponse:
    if not request.keywords and not (request.raw_query and request.raw_query.strip()):
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    boolean_query = _boolean_source(request)
    engine = get_engine()

    try:
        papers = engine.search(boolean_query)
    except BooleanQueryError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid boolean query: {exc}")
    except OpenSearchNotConfiguredError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Semantic Scholar mode is not configured: {exc}",
        )
    except Exception as exc:  # connection / query errors
        raise HTTPException(status_code=502, detail=f"Semantic Scholar search failed: {exc}")

    await archetype.classify_papers(papers)

    return SearchResponse(
        papers=papers,
        total_found=len(papers),
        total_available=len(papers),
        sources_queried=["semantic_scholar"],
        sources_failed=[],
        queries_used={"semantic_scholar": boolean_query},
        deduplication_removed=0,
        background_job_id=None,
    )


def _ndjson(obj: dict) -> bytes:
    """One NDJSON record: a compact JSON object followed by a newline."""
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def _drain(iterator, n: int):
    """Pull up to ``n`` items off a (blocking) iterator. Runs in a worker thread.

    Returns ``(batch, error)``. If the iterator raises, the items collected *before* the
    failure are still returned so they can be emitted, with the exception in ``error``.
    """
    batch = []
    error = None
    for _ in range(n):
        try:
            batch.append(next(iterator))
        except StopIteration:
            break
        except Exception as exc:  # noqa: BLE001 — surfaced to the client as an error line
            error = exc
            break
    return batch, error


@router.post("/search/stream")
async def scholar_search_stream(request: SearchRequest) -> StreamingResponse:
    """Stream matching papers as NDJSON (``application/x-ndjson``).

    Each line is a JSON object:
      * ``{"type": "paper", "paper": {...}}`` — one result, BM25-ordered for a finite limit,
        ``_doc``-ordered (and potentially millions) when the limit is unbounded.
      * ``{"type": "summary", "total_found": N, ...}`` — terminal line with the same metadata
        fields as ``SearchResponse`` (minus ``papers``).
      * ``{"type": "error", "detail": "..."}`` — terminal line if the scroll fails mid-stream
        (the HTTP status is already 200 by then, so failures are reported in-band).

    Request/query validation still fails fast with a normal 4xx/503 before streaming starts.
    """
    if not request.keywords and not (request.raw_query and request.raw_query.strip()):
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    boolean_query = _boolean_source(request)
    engine = get_engine()

    # Fail fast with a real HTTP status *before* the 200 stream is committed.
    if not engine.is_configured:
        raise HTTPException(
            status_code=503, detail="Semantic Scholar mode is not configured."
        )
    try:
        compile_to_opensearch(boolean_query)  # validate syntax up front
    except BooleanQueryError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid boolean query: {exc}")

    async def stream() -> AsyncIterator[bytes]:
        iterator = engine.iter_search(boolean_query)
        total = 0
        while True:
            # Pull a batch off the blocking scroll in a worker thread so the event loop is
            # never blocked, then classify the batch before emitting it.
            batch, error = await anyio.to_thread.run_sync(_drain, iterator, _STREAM_BATCH)
            if batch:
                await archetype.classify_papers(batch)
                for paper in batch:
                    total += 1
                    yield _ndjson({"type": "paper", "paper": paper.model_dump(mode="json")})
            if error is not None:
                # The 200 stream is already committed, so report failures in-band. Emit any
                # papers gathered before the failure first (done above), then a terminal line.
                detail = str(error) if isinstance(error, OpenSearchError) else f"stream failed: {error}"
                yield _ndjson({"type": "error", "detail": detail})
                return
            if not batch:
                break
        yield _ndjson({
            "type": "summary",
            "total_found": total,
            "total_available": total,
            "sources_queried": ["semantic_scholar"],
            "sources_failed": [],
            "queries_used": {"semantic_scholar": boolean_query},
            "deduplication_removed": 0,
            "background_job_id": None,
        })

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
