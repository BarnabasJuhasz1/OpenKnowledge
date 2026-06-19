"""Citation graph builder over hosted data only.

The graph is assembled entirely from the self-hosted Semantic Scholar corpus — **no calls
to the public ``api.semanticscholar.org``**:

* **Node metadata & seed resolution**: OpenSearch ``papers`` index, keyed by integer
  ``corpusid`` (see :mod:`.opensearch_search`). OpenSearch holds no edges, so it can only
  supply nodes; corpusids absent from the index are dropped (OpenSearch-only by decision).
* **Edges (graph structure)**: BigQuery clustered edge tables (see
  :mod:`.bigquery_citations`), looked up cheaply per corpusid.

Edge convention (unchanged from the previous implementation): an edge ``source -> target``
means *source cites target*. So a seed's references give ``(seed, neighbor)`` and a seed's
citers give ``(neighbor, seed)``.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import anyio

from ...models.paper import Paper
from .bigquery_citations import (
    BigQueryCitationsError,
    BigQueryNotConfiguredError,
    get_citation_graph,
)
from .opensearch_search import OpenSearchError, get_engine

logger = logging.getLogger(__name__)


class UpstreamError(Exception):
    """A hosted backend (OpenSearch metadata or BigQuery edges) failed transiently.

    Kept (repurposed from the old public-API era) so the API layer can distinguish a
    genuine "no data" empty graph from a backend failure and report HTTP 503 accordingly.
    """


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
    predicted_main_archetype: str | None = None
    predicted_second_tier_archetype: str | None = None


@dataclass
class CitGraphEdge:
    source: str
    target: str


@dataclass
class CitGraphResult:
    nodes: list[CitGraphNode]
    edges: list[CitGraphEdge]
    seed_id: str


def _paper_to_node(p: Paper, hop: int) -> CitGraphNode:
    return CitGraphNode(
        paper_id=str(p.semantic_scholar_id) if p.semantic_scholar_id is not None else "",
        doi=p.doi,
        arxiv_id=p.arxiv_id,
        title=p.title or "",
        abstract=p.abstract,
        year=p.year,
        citation_count=p.citation_count,
        reference_count=p.reference_count,
        authors=[a.name for a in (p.authors or []) if a and a.name],
        journal=p.journal or p.venue,
        is_open_access=bool(p.is_open_access),
        pdf_url=p.pdf_url or p.landing_url,
        fields_of_study=list(p.fields_of_study or []),
        hop=hop,
    )


def matches_keywords(title: str | None, abstract: str | None, keywords: list[str]) -> bool:
    if not keywords:
        return True
    text = f"{title or ''} {abstract or ''}".lower()
    return any(k.lower() in text for k in keywords if k)


async def _hydrate(corpusids: list[int], hop: int) -> dict[int, CitGraphNode]:
    """Fetch node metadata for ``corpusids`` from OpenSearch (only those present)."""
    if not corpusids:
        return {}
    engine = get_engine()
    try:
        papers = await anyio.to_thread.run_sync(engine.fetch_nodes_by_corpusid, corpusids)
    except OpenSearchError as exc:
        raise UpstreamError(f"OpenSearch node fetch failed: {exc}") from exc
    return {cid: _paper_to_node(p, hop) for cid, p in papers.items()}


async def _traverse(
    seeds: list[str],
    direction: str,  # 'past', 'future', 'both'
    k: int,
    max_per_hop: int,
    keywords: list[str],
    include_non_matching: bool,
) -> CitGraphResult:
    engine = get_engine()
    bq = get_citation_graph()

    # 1. Resolve seed strings -> corpusids and hydrate the seed nodes (hop 0).
    try:
        resolved = await anyio.to_thread.run_sync(engine.resolve_corpusids, seeds)
    except OpenSearchError as exc:
        raise UpstreamError(f"OpenSearch seed resolution failed: {exc}") from exc
    seed_cids: list[int] = []
    seen_seed: set[int] = set()
    for s in seeds:  # preserve request order, de-dup
        cid = resolved.get(s)
        if cid is not None and cid not in seen_seed:
            seen_seed.add(cid)
            seed_cids.append(cid)

    if not seed_cids:
        return CitGraphResult(nodes=[], edges=[], seed_id="")

    nodes: dict[int, CitGraphNode] = await _hydrate(seed_cids, hop=0)
    # Keep only seeds that actually exist in the index (OpenSearch-only).
    seed_cids = [c for c in seed_cids if c in nodes]
    if not seed_cids:
        return CitGraphResult(nodes=[], edges=[], seed_id="")

    edges: list[CitGraphEdge] = []
    edge_set: set[tuple[int, int]] = set()
    frontier = list(seed_cids)

    want_past = direction in ("past", "both")
    want_future = direction in ("future", "both")

    for hop in range(1, k + 1):
        if not frontier:
            break

        # Raw (citing, cited) edges for this hop from BigQuery.
        raw: list[tuple[int, int]] = []
        try:
            if want_past:
                raw += await anyio.to_thread.run_sync(bq.references, frontier, max_per_hop)
            if want_future:
                raw += await anyio.to_thread.run_sync(bq.citations, frontier, max_per_hop)
        except (BigQueryNotConfiguredError, BigQueryCitationsError) as exc:
            raise UpstreamError(f"BigQuery edge lookup failed: {exc}") from exc

        # Candidate neighbours = endpoints not already known as nodes.
        candidates: set[int] = set()
        for citing, cited in raw:
            for endpoint in (citing, cited):
                if endpoint not in nodes:
                    candidates.add(endpoint)
        hop_nodes = await _hydrate(list(candidates), hop=hop)

        # A neighbour is usable iff it is already a node or present in OpenSearch now,
        # and (when filtering) matches the keywords.
        def _usable(cid: int) -> bool:
            node = nodes.get(cid) or hop_nodes.get(cid)
            if node is None:  # not in the index -> dropped (OpenSearch-only)
                return False
            if not include_non_matching and cid not in seen_seed:
                return matches_keywords(node.title, node.abstract, keywords)
            return True

        next_frontier: list[int] = []
        for citing, cited in raw:
            if not (_usable(citing) and _usable(cited)):
                continue
            key = (citing, cited)
            if key in edge_set:
                continue
            edge_set.add(key)
            for cid in (citing, cited):
                if cid not in nodes:
                    nodes[cid] = hop_nodes[cid]
                    next_frontier.append(cid)
            edges.append(CitGraphEdge(source=str(citing), target=str(cited)))

        frontier = next_frontier

    return CitGraphResult(
        nodes=list(nodes.values()),
        edges=edges,
        seed_id=str(seed_cids[0]),
    )


async def build_citation_graph(
    paper_id: str,
    k: int = 1,
    max_per_hop: int = 20,
) -> CitGraphResult:
    """Build a bidirectional citation graph around a single seed, from hosted data."""
    return await _traverse(
        [paper_id], "both", k, max_per_hop, keywords=[], include_non_matching=True
    )


async def explore_citation_graph(
    seeds: list[str],
    direction: str,  # 'past', 'future', 'both'
    include_non_matching: bool = True,
    keywords: list[str] = [],
    k: int = 1,
    max_per_hop: int = 20,
) -> CitGraphResult:
    """Expand a citation graph from multiple seeds in a chosen direction, from hosted data."""
    return await _traverse(
        seeds, direction, k, max_per_hop, keywords or [], include_non_matching
    )
