from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)


class UpstreamError(Exception):
    """A Semantic Scholar request failed for a reason other than a clean 404.

    Used to distinguish a genuine "paper does not exist" (404 -> ``None``) from a
    transient failure such as rate limiting (HTTP 429) or a network error, so the
    API layer can report an accurate, actionable message instead of a misleading
    "paper not found".
    """


_BASE_URL = "https://api.semanticscholar.org/graph/v1/paper"
_MATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search/match"
_FIELDS = "paperId,externalIds,title,abstract,year,citationCount,referenceCount,authors,isOpenAccess,openAccessPdf,journal,publicationDate,fieldsOfStudy"
_REF_CIT_FIELDS = "paperId,externalIds,title,abstract,year,citationCount,referenceCount,authors,isOpenAccess,openAccessPdf,journal,publicationDate,fieldsOfStudy"


@dataclass
class CitGraphNode:
    paper_id: str
    doi: str | None = None
    arxiv_id: str | None = None
    title: str = ""
    abstract: str | None = None
    year: int | None = None
    citation_count: int | None = None
    reference_count: int | None = None
    authors: list[str] = field(default_factory=list)
    journal: str | None = None
    is_open_access: bool = False
    pdf_url: str | None = None
    fields_of_study: list[str] = field(default_factory=list)
    hop: int = 0


@dataclass
class CitGraphEdge:
    source: str
    target: str


@dataclass
class CitGraphResult:
    nodes: list[CitGraphNode]
    edges: list[CitGraphEdge]
    seed_id: str


def _normalize_node(data: dict, hop: int) -> CitGraphNode | None:
    pid = data.get("paperId")
    if not pid:
        return None
    ext = data.get("externalIds") or {}
    authors = [a.get("name", "") for a in (data.get("authors") or [])]
    journal = data.get("journal") or {}
    oa_pdf = data.get("openAccessPdf") or {}
    return CitGraphNode(
        paper_id=pid,
        doi=ext.get("DOI"),
        arxiv_id=ext.get("ArXiv"),
        title=data.get("title") or "",
        abstract=data.get("abstract"),
        year=data.get("year"),
        citation_count=data.get("citationCount"),
        reference_count=data.get("referenceCount"),
        authors=authors,
        journal=journal.get("name") if isinstance(journal, dict) else journal,
        is_open_access=data.get("isOpenAccess", False),
        pdf_url=oa_pdf.get("url") if isinstance(oa_pdf, dict) else None,
        fields_of_study=data.get("fieldsOfStudy") or [],
        hop=hop,
    )


async def build_citation_graph(
    paper_id: str,
    k: int = 1,
    max_per_hop: int = 20,
    api_key: str | None = None,
) -> CitGraphResult:
    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0), follow_redirects=True)
    try:
        return await _bfs(client, paper_id, k, max_per_hop, api_key)
    finally:
        await client.aclose()


async def _bfs(
    client: httpx.AsyncClient,
    seed_id: str,
    k: int,
    max_per_hop: int,
    api_key: str | None,
) -> CitGraphResult:
    visited: dict[str, CitGraphNode] = {}
    edges: list[CitGraphEdge] = []
    edge_set: set[tuple[str, str]] = set()

    # The seed may be an identifier (DOI, S2 ID, arXiv ID) or a free-text paper
    # title. Resolve titles to a canonical Semantic Scholar paperId first.
    lookup_id = await _resolve_seed_id(client, seed_id, api_key)

    seed_data = await _fetch_paper(client, lookup_id, api_key)
    if not seed_data:
        return CitGraphResult(nodes=[], edges=[], seed_id=seed_id)

    seed_node = _normalize_node(seed_data, 0)
    if not seed_node:
        return CitGraphResult(nodes=[], edges=[], seed_id=seed_id)
    visited[seed_node.paper_id] = seed_node
    resolved_seed_id = seed_node.paper_id
    # Traverse from the canonical paperId so edge endpoints match the seed node.
    frontier: list[str] = [resolved_seed_id]

    for hop in range(1, k + 1):
        next_frontier: list[str] = []

        for paper_id in frontier:
            refs, cits = await _fetch_refs_and_cits(client, paper_id, api_key)
            await asyncio.sleep(0.5)

            combined = refs[:max_per_hop] + cits[:max_per_hop]
            for item in combined:
                cited_paper = item.get("citedPaper") or item.get("citingPaper")
                if not cited_paper:
                    continue
                node = _normalize_node(cited_paper, hop)
                if not node:
                    continue

                is_ref = "citedPaper" in item
                if is_ref:
                    edge_key = (paper_id, node.paper_id)
                else:
                    edge_key = (node.paper_id, paper_id)

                if edge_key not in edge_set:
                    edge_set.add(edge_key)
                    edges.append(CitGraphEdge(source=edge_key[0], target=edge_key[1]))

                if node.paper_id not in visited:
                    visited[node.paper_id] = node
                    next_frontier.append(node.paper_id)

        frontier = next_frontier

    return CitGraphResult(
        nodes=list(visited.values()),
        edges=edges,
        seed_id=resolved_seed_id,
    )


async def _get_with_retry(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    headers: dict,
    max_retries: int = 4,
) -> httpx.Response | None:
    """GET with 429-aware retry.

    Returns ``None`` only on a genuine 404 (resource does not exist). Raises
    :class:`UpstreamError` on a network error or when rate limiting (429) /
    another HTTP error persists past ``max_retries`` — these are transient and
    must not be confused with "not found".
    """
    for attempt in range(max_retries + 1):
        try:
            resp = await client.get(url, params=params, headers=headers)
        except httpx.HTTPError as e:
            logger.warning("Request error for %s: %s", url, e)
            raise UpstreamError(f"Network error contacting Semantic Scholar: {e}") from e
        if resp.status_code == 404:
            return None
        if resp.status_code == 429:
            if attempt == max_retries:
                logger.warning("Rate limited (429) after %d retries: %s", max_retries, url)
                raise UpstreamError(
                    "Semantic Scholar rate limit reached (HTTP 429). Set "
                    "SEMANTIC_SCHOLAR_API_KEY to raise the limit, or retry shortly."
                )
            try:
                retry_after = int(resp.headers.get("Retry-After", "2"))
            except ValueError:
                retry_after = 2
            await asyncio.sleep(retry_after * (attempt + 1))
            continue
        if resp.status_code >= 400:
            logger.warning("HTTP %d for %s", resp.status_code, url)
            raise UpstreamError(
                f"Semantic Scholar returned HTTP {resp.status_code} for {url}"
            )
        return resp
    return None


def _looks_like_identifier(value: str) -> bool:
    """Decide whether the seed is an ID rather than a paper title.

    Every Semantic Scholar identifier form — bare S2 hashes, ``DOI:``/``ARXIV:``
    prefixed ids, raw DOIs, arXiv ids — is a single whitespace-free token, while
    paper titles are multi-word. So treat anything containing whitespace as a
    title and everything else as an identifier to look up directly.
    """
    v = value.strip()
    return bool(v) and not any(c.isspace() for c in v)


async def _match_title(
    client: httpx.AsyncClient, title: str, api_key: str | None
) -> str | None:
    """Resolve a free-text title to the best-matching S2 paperId."""
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    params = {"query": title, "fields": "paperId,title"}
    resp = await _get_with_retry(client, _MATCH_URL, params, headers)
    if resp is None:
        return None
    data = resp.json().get("data") or []
    if data and isinstance(data[0], dict):
        return data[0].get("paperId")
    return None


async def _resolve_seed_id(
    client: httpx.AsyncClient, seed: str, api_key: str | None
) -> str:
    """Return a Semantic Scholar lookup id for the seed.

    Identifiers are returned untouched; titles are resolved via the title-match
    endpoint, falling back to the raw string if no match is found.
    """
    seed = seed.strip()
    if _looks_like_identifier(seed):
        return seed
    matched = await _match_title(client, seed, api_key)
    # The match call and the seed fetch are back-to-back requests; on the
    # unauthenticated (~1 req/s) tier that pair alone can trip the rate limit,
    # so space them out slightly.
    await asyncio.sleep(0.5)
    return matched or seed


async def _fetch_paper(
    client: httpx.AsyncClient, paper_id: str, api_key: str | None
) -> dict | None:
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    url = f"{_BASE_URL}/{paper_id}"
    resp = await _get_with_retry(client, url, {"fields": _FIELDS}, headers)
    return resp.json() if resp is not None else None


async def _fetch_refs_and_cits(
    client: httpx.AsyncClient, paper_id: str, api_key: str | None
) -> tuple[list[dict], list[dict]]:
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    refs_url = f"{_BASE_URL}/{paper_id}/references"
    cits_url = f"{_BASE_URL}/{paper_id}/citations"
    params = {"fields": _REF_CIT_FIELDS, "limit": 100}

    async def _get(url: str) -> list[dict]:
        # Tolerate transient upstream failures here: a rate-limited neighbour
        # fetch should yield a smaller graph, not abort the whole build.
        try:
            resp = await _get_with_retry(client, url, params, headers)
        except UpstreamError as e:
            logger.warning("Skipping neighbours for %s: %s", url, e)
            return []
        if resp is None:
            return []
        # S2 may return {"data": null}; `.get(..., [])` only covers a missing
        # key, so coalesce an explicit null to an empty list.
        return resp.json().get("data") or []

    refs, cits = await asyncio.gather(_get(refs_url), _get(cits_url))
    return refs, cits
