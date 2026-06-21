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
import logging
import os
from collections.abc import AsyncIterator

import anyio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..models.paper import (
    ScholarPageRequest,
    ScholarPageResponse,
    SearchRequest,
    SearchResponse,
)
from ..services import archetype
from ..services.archetype import cache as archetype_cache
from ..services.retrieval.boolean_query import BooleanQueryError, compile_to_opensearch
from ..services.retrieval.opensearch_search import (
    _MAX_RESULT_WINDOW,
    OpenSearchError,
    OpenSearchNotConfiguredError,
    get_engine,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/retrieval/scholar", tags=["scholar"])

# Papers are pulled (and archetype-classified) in batches of this size while streaming, so
# memory stays bounded regardless of how many million the query matches.
_STREAM_BATCH = 500

# Hard backstop on how many papers a single Scholar search may return, applied even when
# OPENSEARCH_RESULT_LIMIT is unset (unlimited). Without it, a broad query like
# "learning OR entailment OR compositional" materialises/streams hundreds of thousands of
# papers and OOM-kills the backend. Tunable via SCHOLAR_MAX_RESULTS.
_DEFAULT_SCHOLAR_MAX_RESULTS = 10000


def _scholar_max_results() -> int:
    """The server-side safety cap from ``SCHOLAR_MAX_RESULTS`` (positive int), else default.

    Unset/empty/invalid/non-positive all fall back to the default — this cap must never
    resolve to "unlimited", since it is the OOM backstop.
    """
    raw = os.getenv("SCHOLAR_MAX_RESULTS")
    if raw is None or raw.strip() == "":
        return _DEFAULT_SCHOLAR_MAX_RESULTS
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "Invalid int for SCHOLAR_MAX_RESULTS=%r; using default %d",
            raw, _DEFAULT_SCHOLAR_MAX_RESULTS,
        )
        return _DEFAULT_SCHOLAR_MAX_RESULTS
    return value if value > 0 else _DEFAULT_SCHOLAR_MAX_RESULTS


def _effective_limit(request: SearchRequest) -> int:
    """Smallest positive cap to apply: the server backstop, or a tighter client request.

    Always a positive int (never ``None``/unlimited) so the search is bounded regardless
    of ``OPENSEARCH_RESULT_LIMIT``. A client may ask for *fewer* via ``max_total_results``
    but cannot exceed the server backstop.
    """
    cap = _scholar_max_results()
    requested = request.max_total_results
    if requested is not None and requested > 0:
        cap = min(cap, requested)
    return cap


def _boolean_source(request: SearchRequest) -> str:
    """The boolean query string to run: the user's raw query, or AND-joined keywords."""
    if request.raw_query and request.raw_query.strip():
        return request.raw_query.strip()
    return " AND ".join(f'"{k}"' if " " in k else k for k in request.keywords)


def _paper_key(p) -> str:
    """Stable identity matching the frontend's paperId() priority."""
    return p.doi or p.arxiv_id or p.semantic_scholar_id or p.openalex_id or p.title


def _archetype_hit(cached, selected: set[str]) -> bool:
    """True if a cached ``(primary, secondary)`` intersects the selected archetypes (OR)."""
    if not cached:
        return False
    primary, secondary = cached
    return (primary in selected) or (secondary in selected)


def _archetype_map(papers) -> dict[str, list[str | None]]:
    """Map paper key -> [primary, secondary] for papers that have an archetype."""
    out: dict[str, list[str | None]] = {}
    for p in papers:
        if p.predicted_main_archetype or p.predicted_second_tier_archetype:
            out[_paper_key(p)] = [
                p.predicted_main_archetype,
                p.predicted_second_tier_archetype,
            ]
    return out


@router.post("/search", response_model=SearchResponse)
async def scholar_search(request: SearchRequest) -> SearchResponse:
    if not request.keywords and not (request.raw_query and request.raw_query.strip()):
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    boolean_query = _boolean_source(request)
    engine = get_engine()
    cap = _effective_limit(request)

    try:
        # Bounded by `cap` so this never materialises an unbounded match set into memory.
        papers = list(engine.iter_search(boolean_query, result_limit=cap))
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


# Upper bound on a single page so one request can never pull an unreasonable batch.
_MAX_PAGE_SIZE = 200


@router.post("/search/page", response_model=ScholarPageResponse)
async def scholar_search_page(request: ScholarPageRequest) -> ScholarPageResponse:
    """One sorted/filtered page of Scholar results, plus the exact total match count.

    The fast, default read path: returns the total immediately and only the requested page
    (top results by ok-score proxy), so the backend holds at most ``page_size`` papers and
    the client fetches further pages on demand. Filters apply across the whole match set.
    """
    if not request.keywords and not (request.raw_query and request.raw_query.strip()):
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    page = max(1, request.page)
    page_size = max(1, min(request.page_size, _MAX_PAGE_SIZE))
    boolean_query = _boolean_source(request)
    engine = get_engine()
    queries_used = {"semantic_scholar": boolean_query}

    # Deep paging past the index result window isn't supported by from/size, so the
    # navigable depth is capped at the smaller of the window and the safety cap.
    cap = min(_scholar_max_results(), _MAX_RESULT_WINDOW)
    offset = (page - 1) * page_size

    # Archetype filtering can't be expressed as an index query (archetypes are classified
    # live, not stored), so when an archetype subset is active we resolve membership from the
    # classification cache: rank the corpusids in the requested order (indexable filters only),
    # keep those whose cached archetype matches, then hydrate just this page. Papers not yet
    # classified are excluded — the set firms up as POST /classify/stream fills the cache.
    selected_archetypes = request.filters.archetypes
    if selected_archetypes:
        selected = set(selected_archetypes)
        base_filters = request.filters.model_copy(update={"archetypes": None})
        try:
            corpusids, _total_all = engine.ranked_corpusids(
                boolean_query, sort=request.sort, limit=cap, filters=base_filters,
            )
        except BooleanQueryError as exc:
            raise HTTPException(status_code=422, detail=f"Invalid boolean query: {exc}")
        except OpenSearchNotConfiguredError as exc:
            raise HTTPException(
                status_code=503, detail=f"Semantic Scholar mode is not configured: {exc}"
            )
        except Exception as exc:  # connection / query errors
            raise HTTPException(status_code=502, detail=f"Semantic Scholar search failed: {exc}")

        matched = [
            cid for cid in corpusids
            if _archetype_hit(archetype_cache.get(archetype_cache.corpusid_key(cid)), selected)
        ]
        total = len(matched)
        page_ids = matched[offset:offset + page_size]
        papers_by_id = engine.fetch_nodes_by_corpusid(page_ids) if page_ids else {}
        papers = []
        for cid in page_ids:
            paper = papers_by_id.get(cid)
            if paper is None:
                continue
            cached = archetype_cache.get(archetype_cache.corpusid_key(cid))
            if cached:
                if cached[0]:
                    paper.predicted_main_archetype = cached[0]
                if cached[1]:
                    paper.predicted_second_tier_archetype = cached[1]
            papers.append(paper)

        return ScholarPageResponse(
            papers=papers,
            total_found=total,
            page=page,
            page_size=page_size,
            has_more=(offset + len(page_ids)) < total,
            queries_used=queries_used,
            result_cap=cap,
        )

    remaining = cap - offset
    # Past the navigable window: fetch nothing (size 0) but still report the real total.
    fetch_offset = offset if remaining > 0 else 0
    fetch_size = min(page_size, remaining) if remaining > 0 else 0

    try:
        papers, total = engine.search_page(
            boolean_query,
            offset=fetch_offset,
            size=fetch_size,
            sort=request.sort,
            filters=request.filters,
        )
    except BooleanQueryError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid boolean query: {exc}")
    except OpenSearchNotConfiguredError as exc:
        raise HTTPException(
            status_code=503, detail=f"Semantic Scholar mode is not configured: {exc}"
        )
    except Exception as exc:  # connection / query errors
        raise HTTPException(status_code=502, detail=f"Semantic Scholar search failed: {exc}")

    # Note: the page is returned WITHOUT waiting on archetype classification. Classification
    # now runs out-of-band via POST /classify/stream (ok-score order, whole match set) and the
    # frontend patches archetypes onto the loaded papers as they stream in — so results render
    # immediately instead of blocking on a remote-model round-trip (incl. cold start).

    has_more = (offset + len(papers)) < min(total, cap)
    return ScholarPageResponse(
        papers=papers,
        total_found=total,
        page=page,
        page_size=page_size,
        has_more=has_more,
        queries_used=queries_used,
        result_cap=cap,
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
    cap = _effective_limit(request)

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
        # `cap` bounds the scroll: memory stays per-batch and the stream always terminates.
        iterator = engine.iter_search(boolean_query, result_limit=cap)
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
            # True when the stream stopped at the safety cap (more matches likely exist).
            "result_cap": cap,
            "capped": total >= cap,
        })

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Papers per classification page. Each page is a fresh from/size OpenSearch query in
# ok-score (relevancy) order, classified via the remote model, then the running
# archetype distribution is pushed to the client — so the panel fills in smoothly.
_CLASSIFY_BATCH = 200


@router.post("/classify/stream")
async def scholar_classify_stream(request: ScholarPageRequest) -> StreamingResponse:
    """Classify the whole Scholar match set in descending ok-score order, streaming the
    running archetype distribution as NDJSON.

    Pages through the matches (``sort="relevancy"`` == citationcount, the ok-score proxy,
    so the highest-scoring papers are classified first), up to the same navigable cap as
    paging. After every batch it emits:
      * ``{"type":"archetypes","data":{paperKey:[primary,secondary]}}`` — per-paper labels
        so loaded result cards/filters get badges.
      * ``{"type":"distribution","counts":{archetype:n},"classified":N,"total":T}`` — the
        cumulative distribution after this batch.
    Terminal line: ``{"type":"done", ...}``. Classification is best-effort: a failed batch
    is logged and skipped, never aborting the stream.
    """
    if not request.keywords and not (request.raw_query and request.raw_query.strip()):
        raise HTTPException(status_code=422, detail="At least one keyword is required.")

    boolean_query = _boolean_source(request)
    engine = get_engine()

    if not engine.is_configured:
        raise HTTPException(status_code=503, detail="Semantic Scholar mode is not configured.")
    try:
        compile_to_opensearch(boolean_query)  # validate syntax up front
    except BooleanQueryError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid boolean query: {exc}")

    cap = min(_scholar_max_results(), _MAX_RESULT_WINDOW)
    filters = request.filters

    async def stream() -> AsyncIterator[bytes]:
        counts: dict[str, int] = {}
        classified = 0
        total = 0
        offset = 0
        while offset < cap:
            size = min(_CLASSIFY_BATCH, cap - offset)
            try:
                papers, total = await anyio.to_thread.run_sync(
                    lambda o=offset, s=size: engine.search_page(
                        boolean_query, offset=o, size=s, sort="relevancy", filters=filters
                    )
                )
            except Exception as exc:  # noqa: BLE001 — report in-band; 200 already committed
                yield _ndjson({"type": "error", "detail": f"search failed: {exc}"})
                return

            if not papers:
                break

            # Classify this ok-score-ordered batch via the remote model (best-effort).
            await archetype.classify_papers(papers)

            for p in papers:
                primary = p.predicted_main_archetype
                if primary and primary != "None":
                    counts[primary] = counts.get(primary, 0) + 1
            classified += len(papers)

            arch_map = _archetype_map(papers)
            if arch_map:
                yield _ndjson({"type": "archetypes", "data": arch_map})
            yield _ndjson({
                "type": "distribution",
                "counts": counts,
                "classified": classified,
                "total": min(total, cap),
            })

            offset += len(papers)
            if offset >= min(total, cap):
                break

        yield _ndjson({
            "type": "done",
            "counts": counts,
            "classified": classified,
            "total": min(total, cap),
        })

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
