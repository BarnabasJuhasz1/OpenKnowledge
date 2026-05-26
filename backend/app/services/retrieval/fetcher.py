from __future__ import annotations
import asyncio
import os
from collections.abc import AsyncGenerator
from ...models.paper import Paper, SearchRequest, SearchResponse, StreamEvent
from ..retrieval.adapters import ADAPTER_MAP, ALL_ADAPTERS
from ..retrieval.adapters.base import DatabaseAdapter
from ..retrieval.query_builder import build_query
from ..retrieval.deduplicator import deduplicate
from ..retrieval.merger import merge_group
from ..retrieval.bibtex import attach_bibtex
from ..retrieval.code_enrichment import enrich_papers
from ..retrieval.cache import cache


def _build_adapters(db_names: list[str] | None) -> list[DatabaseAdapter]:
    email = os.getenv("CONTACT_EMAIL")
    keys = {
        "semantic_scholar": os.getenv("SEMANTIC_SCHOLAR_API_KEY"),
        "core": os.getenv("CORE_API_KEY"),
        "pubmed": os.getenv("PUBMED_API_KEY"),
    }
    classes = (
        [ADAPTER_MAP[n] for n in db_names if n in ADAPTER_MAP]
        if db_names
        else ALL_ADAPTERS
    )
    return [cls(api_key=keys.get(cls.name), contact_email=email) for cls in classes]


async def _run_adapter(
    adapter: DatabaseAdapter,
    query: str,
) -> tuple[str, list[Paper] | Exception]:
    try:
        papers = await asyncio.wait_for(
            adapter.search(query),
            timeout=300.0,
        )
        return adapter.name, papers
    except Exception as exc:
        return adapter.name, exc
    finally:
        await adapter.close()


def _compute_strictness(n_kw: int) -> float:
    if n_kw <= 3:
        return 0.8
    elif n_kw <= 6:
        return 0.5
    else:
        return min(0.3, 3.0 / n_kw)


async def search(request: SearchRequest) -> SearchResponse:
    adapters = _build_adapters(request.databases)

    queries_used: dict[str, str] = {}
    tasks = []
    for adapter in adapters:
        if request.raw_query:
            query = request.raw_query
        else:
            strictness = _compute_strictness(len(request.keywords))
            query = build_query(
                request.keywords,
                adapter.name,
                domain_filter=request.domain_filter,
                strictness=strictness,
            )
        queries_used[adapter.name] = query
        tasks.append(_run_adapter(adapter, query))

    outcomes = await asyncio.gather(*tasks)

    all_papers: list[Paper] = []
    sources_queried: list[str] = []
    sources_failed: list[str] = []

    for db_name, result in outcomes:
        sources_queried.append(db_name)
        if isinstance(result, Exception):
            sources_failed.append(db_name)
        else:
            all_papers.extend(result)

    # Deduplicate → list of groups
    groups, n_removed = deduplicate(all_papers)

    # Merge each group into one record
    merged: list[Paper] = [merge_group(g) for g in groups]

    # Attach BibTeX to every paper
    attach_bibtex(merged)

    # Enrich with code URLs, repo stars, and dataset detection
    await enrich_papers(merged)

    return SearchResponse(
        papers=merged,
        total_found=len(merged),
        sources_queried=sources_queried,
        sources_failed=sources_failed,
        queries_used=queries_used,
        deduplication_removed=n_removed,
    )


def _describe_error(exc: Exception, adapter_name: str) -> str:
    """Return a brief, user-friendly description of what went wrong."""
    import httpx

    if isinstance(exc, asyncio.TimeoutError):
        return "Request timed out"

    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 429:
            return "Rate limited — too many requests"
        if status == 401 or status == 403:
            return "Missing or invalid API key"
        if status == 400:
            return "Bad request — query may be malformed"
        if status >= 500:
            return f"Server error (HTTP {status})"
        return f"HTTP {status}"

    if isinstance(exc, httpx.ConnectError):
        return "Could not connect to API"

    if isinstance(exc, httpx.ReadTimeout):
        return "API response timed out"

    # Generic fallback
    msg = str(exc)
    if len(msg) > 80:
        msg = msg[:77] + "..."
    return msg or "Unknown error"


async def search_stream(request: SearchRequest) -> AsyncGenerator[StreamEvent, None]:
    """Yield StreamEvent objects as each database adapter completes."""
    adapters = _build_adapters(request.databases)

    queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue()

    async def _run_and_enqueue(adapter: DatabaseAdapter) -> None:
        if request.raw_query:
            query = request.raw_query
        else:
            strictness = _compute_strictness(len(request.keywords))
            query = build_query(
                request.keywords,
                adapter.name,
                domain_filter=request.domain_filter,
                strictness=strictness,
            )
        try:
            papers = await asyncio.wait_for(
                adapter.search(query),
                timeout=300.0,
            )
            attach_bibtex(papers)
            await enrich_papers(papers)
            await queue.put(StreamEvent(
                source=adapter.name,
                papers=papers,
                query_used=query,
                failed=False,
            ))
        except Exception as exc:
            await queue.put(StreamEvent(
                source=adapter.name,
                papers=[],
                query_used=query,
                failed=True,
                error_message=_describe_error(exc, adapter.name),
            ))
        finally:
            await adapter.close()

    # Launch all adapter tasks concurrently
    tasks = [asyncio.create_task(_run_and_enqueue(a)) for a in adapters]

    # Yield events as they arrive
    completed = 0
    total = len(tasks)
    while completed < total:
        event = await queue.get()
        if event is not None:
            completed += 1
            yield event

    # Ensure all tasks are done (cleanup)
    await asyncio.gather(*tasks, return_exceptions=True)
