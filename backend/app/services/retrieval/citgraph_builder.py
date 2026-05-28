from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.semanticscholar.org/graph/v1/paper"
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
    frontier: list[str] = [seed_id]

    seed_data = await _fetch_paper(client, seed_id, api_key)
    if not seed_data:
        return CitGraphResult(nodes=[], edges=[], seed_id=seed_id)

    seed_node = _normalize_node(seed_data, 0)
    if not seed_node:
        return CitGraphResult(nodes=[], edges=[], seed_id=seed_id)
    visited[seed_node.paper_id] = seed_node
    resolved_seed_id = seed_node.paper_id

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
    max_retries: int = 3,
) -> httpx.Response | None:
    """GET with 429-aware retry. Returns None on 404 or exhausted retries."""
    for attempt in range(max_retries + 1):
        try:
            resp = await client.get(url, params=params, headers=headers)
        except httpx.HTTPError as e:
            logger.warning("Request error for %s: %s", url, e)
            return None
        if resp.status_code == 404:
            return None
        if resp.status_code == 429:
            if attempt == max_retries:
                logger.warning("Rate limited (429) after %d retries: %s", max_retries, url)
                return None
            try:
                retry_after = int(resp.headers.get("Retry-After", "2"))
            except ValueError:
                retry_after = 2
            await asyncio.sleep(retry_after * (attempt + 1))
            continue
        if resp.status_code >= 400:
            logger.warning("HTTP %d for %s", resp.status_code, url)
            return None
        return resp
    return None


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
        resp = await _get_with_retry(client, url, params, headers)
        if resp is None:
            return []
        return resp.json().get("data", [])

    refs, cits = await asyncio.gather(_get(refs_url), _get(cits_url))
    return refs, cits
