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
import os
from collections import defaultdict
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

# When a per-paper top-K cap is in force and no keyword filter can drop the high-citation
# picks, BigQuery's ranked QUALIFY (ORDER BY neighbor_citationcount) returns exactly the
# neighbours we keep, so we push a small per-source cap down instead of fetching everything.
# We over-fetch by this factor because OpenSearch coverage is partial: a top-by-citation
# neighbour absent from the index is dropped at hydration, so the buffer keeps enough usable
# candidates to still fill K. Tunable; 0/negative disables the pushdown (always fetch wide).
def _bq_overfetch() -> int:
    try:
        return int(os.getenv("CITGRAPH_BQ_OVERFETCH", "10"))
    except ValueError:
        return 10


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
    top_k_per_paper: list[int | None] | int | None = None,
    max_per_hop_total: int | None = None,
) -> CitGraphResult:
    """Traverse the citation graph.

    ``max_per_hop`` is the per-source-paper *fetch* cap applied at the edge source
    (BigQuery), a cost/scan bound. ``top_k_per_paper`` then keeps each paper's K
    highest-ok-score neighbours, and ``max_per_hop_total`` finally caps the *total*
    number of new papers added in a hop to the globally highest-ok-score ones
    (cumulative across all frontier papers). ok-score is proxied by
    ``citation_count`` — see the per-paper cap comment below.
    """
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
    # Keyword filtering can drop a high-citation neighbour after hydration, so the kept
    # top-K is taken among matches — meaning we must NOT pre-cap by citation at the source
    # when it is active. Invariant across hops.
    keyword_filtering = (not include_non_matching) and bool(keywords)
    overfetch = _bq_overfetch()

    def _top_k_for_hop(hop: int) -> int | None:
        """The per-paper top-K cap active for ``hop`` (None = keep all)."""
        if top_k_per_paper is None:
            return None
        if isinstance(top_k_per_paper, list):
            if not top_k_per_paper:
                return None
            return top_k_per_paper[hop - 1] if hop <= len(top_k_per_paper) else top_k_per_paper[-1]
        return top_k_per_paper

    for hop in range(1, k + 1):
        if not frontier:
            break

        # Per-paper top-K cap for this hop (used both to push a cap down to BigQuery and
        # to trim each anchor's neighbours after hydration).
        current_top_k = _top_k_for_hop(hop)

        # Push the cap down to BigQuery only when it is provably result-equivalent: a
        # per-paper top-K is set and no keyword filter can discard the high-citation picks.
        # We over-fetch (cap * factor) so partial OpenSearch coverage still leaves K usable
        # neighbours; the exact top-K is then selected in Python below.
        effective_cap = max_per_hop
        if current_top_k is not None and not keyword_filtering and overfetch > 0:
            effective_cap = min(max_per_hop, max(current_top_k * overfetch, current_top_k))

        # This hop's edges, each tagged with its *anchor* — the frontier paper the
        # neighbour hangs off — so a per-paper cap can be applied below. For a
        # reference the anchor is the citing side; for a citation it's the cited
        # side. Item shape: (anchor, neighbour, (citing, cited)). Fetch order is
        # preserved (references then citations), matching the legacy traversal.
        # Fetch references (past) and citations (future) concurrently: they are
        # independent BigQuery jobs and each carries a large fixed per-job latency, so
        # running them in parallel roughly halves a 'both'-direction hop. The helpers
        # capture BigQuery errors instead of raising so the task group always exits
        # cleanly; we then surface them as UpstreamError in normal control flow.
        edge_results: dict[str, list[tuple[int, int]]] = {"refs": [], "cites": []}
        edge_errors: list[Exception] = []

        async def _fetch_edges(kind: str, fn) -> None:
            try:
                edge_results[kind] = await anyio.to_thread.run_sync(fn, frontier, effective_cap)
            except (BigQueryNotConfiguredError, BigQueryCitationsError) as exc:
                edge_errors.append(exc)

        async with anyio.create_task_group() as tg:
            if want_past:
                tg.start_soon(_fetch_edges, "refs", bq.references)
            if want_future:
                tg.start_soon(_fetch_edges, "cites", bq.citations)

        if edge_errors:
            raise UpstreamError(
                f"BigQuery edge lookup failed: {edge_errors[0]}"
            ) from edge_errors[0]

        # Merge in a fixed order (references then citations) so traversal stays
        # deterministic regardless of which thread finished first.
        tagged: list[tuple[int, int, tuple[int, int]]] = []
        for citing, cited in edge_results["refs"]:
            tagged.append((citing, cited, (citing, cited)))
        for citing, cited in edge_results["cites"]:
            tagged.append((cited, citing, (citing, cited)))

        # Candidate neighbours = endpoints not already known as nodes.
        candidates: set[int] = set()
        for _anchor, _neighbour, (citing, cited) in tagged:
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

        usable = [t for t in tagged if _usable(t[2][0]) and _usable(t[2][1])]

        # ok-score proxy: expanded neighbours are not ok-score-enriched, so their
        # ok-score is w_c·log10(1 + citation_count) — monotonic in citation_count —
        # and citation_count is the only signal available at expansion time.
        def _cite_count(cid: int) -> int:
            node = nodes.get(cid) or hop_nodes.get(cid)
            return (node.citation_count or 0) if node else -1

        # Per-paper top-K cap: keep only the K highest-ok-score neighbours taken
        # from any single anchor paper (e.g. a foundational work's most relevant
        # citers). ``current_top_k`` was computed above (and may already have bounded
        # the BigQuery fetch); this trims to the exact top-K among usable neighbours.
        if current_top_k is not None:
            grouped: dict[int, list[tuple[int, int, tuple[int, int]]]] = defaultdict(list)
            for t in usable:
                grouped[t[0]].append(t)
            capped: list[tuple[int, int, tuple[int, int]]] = []
            for items in grouped.values():
                # Stable sort: ties keep fetch order, so the result is deterministic.
                items.sort(key=lambda t: _cite_count(t[1]), reverse=True)
                capped.extend(items[:current_top_k])
            usable = capped

        # Cumulative per-hop cap: across ALL frontier papers, add at most
        # ``max_per_hop_total`` *new* papers this hop — the globally highest-ok-score
        # ones — so the graph cannot explode as the frontier grows. Counts distinct
        # new nodes (not edges); edges to papers that don't make the cut are dropped,
        # while edges to already-known papers are always kept.
        if max_per_hop_total is not None:
            new_scores: dict[int, int] = {}
            for _anchor, neighbour, _edge in usable:
                if neighbour not in nodes and neighbour not in new_scores:
                    new_scores[neighbour] = _cite_count(neighbour)
            if len(new_scores) > max_per_hop_total:
                kept_new = {
                    cid for cid, _ in sorted(
                        new_scores.items(), key=lambda kv: kv[1], reverse=True
                    )[:max_per_hop_total]
                }
                usable = [t for t in usable if t[1] in nodes or t[1] in kept_new]

        next_frontier: list[int] = []
        for _anchor, _neighbour, (citing, cited) in usable:
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


_EXPLORE_FETCH_CAP = 100_000


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
    max_per_hop: int | None = None,
    top_k_per_paper: list[int | None] | int | None = None,
) -> CitGraphResult:
    """Expand a citation graph from multiple seeds in a chosen direction, from hosted data."""
    return await _traverse(
        seeds,
        direction,
        k,
        _EXPLORE_FETCH_CAP,
        keywords or [],
        include_non_matching,
        top_k_per_paper=top_k_per_paper,
        max_per_hop_total=max_per_hop,
    )

