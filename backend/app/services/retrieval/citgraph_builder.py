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
from .boolean_query import compile_text_predicate
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
    is_influential: bool = False


@dataclass
class CitGraphResult:
    nodes: list[CitGraphNode]
    edges: list[CitGraphEdge]
    seed_id: str


def merge_cit_graph_results(*results: CitGraphResult) -> CitGraphResult:
    """Union the node/edge sets of direction-pure cones into one graph (v2).

    Used by the "directional split" (v2) construction, which builds a pure future
    cone and a pure past cone separately and merges them. Nodes are keyed by
    ``paper_id``; when the same paper appears in more than one cone (a seed at
    hop 0, or a paper that is both a descendant and an ancestor of the seeds) the
    smaller ``hop`` wins so distance-from-seed stays meaningful. Edges are keyed
    by ``(source, target)`` and ``is_influential`` is OR-ed across duplicates.
    ``seed_id`` is the first non-empty one. First-appearance order is preserved.
    """
    nodes: dict[str, CitGraphNode] = {}
    for res in results:
        for n in res.nodes:
            existing = nodes.get(n.paper_id)
            if existing is None:
                nodes[n.paper_id] = n
            elif n.hop < existing.hop:
                nodes[n.paper_id] = n

    edges: dict[tuple[str, str], CitGraphEdge] = {}
    for res in results:
        for e in res.edges:
            key = (e.source, e.target)
            existing_e = edges.get(key)
            if existing_e is None:
                edges[key] = e
            elif e.is_influential and not existing_e.is_influential:
                existing_e.is_influential = True

    seed_id = ""
    for res in results:
        if res.seed_id:
            seed_id = res.seed_id
            break

    return CitGraphResult(
        nodes=list(nodes.values()), edges=list(edges.values()), seed_id=seed_id
    )


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


def node_matches_filter(node: CitGraphNode, node_filter: object) -> bool:
    """Whether a hydrated node satisfies a metadata ``node_filter``.

    ``node_filter`` is duck-typed (e.g. the API ``GraphNodeFilter``); only fields
    available on OpenSearch-hydrated nodes are checked — year, citation_count,
    open-access, fields-of-study. A null ``year`` fails a set year bound; a null
    ``citation_count`` is treated as 0 (mirrors the client/search semantics).
    """
    nf = node_filter
    year_intervals = getattr(nf, "year_intervals", None)
    if year_intervals:
        # Disconnected windows (e.g. multi-seed "around seed papers" mode). Pass iff
        # the year lands in any [lo, hi]; a null year fails, as with the single bound.
        if node.year is None or not any(
            lo <= node.year <= hi for lo, hi in year_intervals
        ):
            return False
    else:
        year_min = getattr(nf, "year_min", None)
        year_max = getattr(nf, "year_max", None)
        if year_min is not None and (node.year is None or node.year < year_min):
            return False
        if year_max is not None and (node.year is None or node.year > year_max):
            return False
    cc = node.citation_count or 0
    citation_min = getattr(nf, "citation_min", None)
    citation_max = getattr(nf, "citation_max", None)
    if citation_min is not None and cc < citation_min:
        return False
    if citation_max is not None and cc > citation_max:
        return False
    if getattr(nf, "open_access_only", False) and not node.is_open_access:
        return False
    fields = getattr(nf, "fields", None) or []
    if fields and not (set(node.fields_of_study or []) & set(fields)):
        return False
    return True


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
    influential_only: bool = False,
    boolean_query: str | None = None,
    node_filter: object | None = None,
) -> CitGraphResult:
    """Traverse the citation graph.

    ``max_per_hop`` is the per-source-paper *fetch* cap applied at the edge source
    (BigQuery), a cost/scan bound. ``top_k_per_paper`` then keeps each paper's K
    highest-ok-score neighbours, and ``max_per_hop_total`` finally caps the *total*
    number of new papers added in a hop to the globally highest-ok-score ones
    (cumulative across all frontier papers). ok-score is proxied by
    ``citation_count`` — see the per-paper cap comment below.

    When ``influential_only`` is set, every non-influential edge is dropped at the
    start of each hop (before candidates are gathered), so the papers those edges
    would have introduced are never added as nodes and never enter the frontier —
    they are not expanded from on later hops.
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
    # Advanced filter (boolean query + metadata) supersedes the legacy keyword path.
    # Parse the boolean query once; an empty/invalid query yields a match-all predicate.
    text_pred = compile_text_predicate(boolean_query) if boolean_query else None
    advanced_filtering = text_pred is not None or node_filter is not None
    # Any filter that can drop a high-citation neighbour after hydration means the kept
    # top-K must be taken among the survivors — so we must NOT pre-cap by citation at the
    # source when one is active. Invariant across hops.
    keyword_filtering = ((not include_non_matching) and bool(keywords)) or advanced_filtering
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
        # side. Item shape: (anchor, neighbour, (citing, cited), is_influential).
        # Fetch order is preserved (references then citations), matching the legacy traversal.
        # Fetch references (past) and citations (future) concurrently: they are
        # independent BigQuery jobs and each carries a large fixed per-job latency, so
        # running them in parallel roughly halves a 'both'-direction hop. The helpers
        # capture BigQuery errors instead of raising so the task group always exits
        # cleanly; we then surface them as UpstreamError in normal control flow.
        edge_results: dict[str, list[tuple[int, int, bool]]] = {"refs": [], "cites": []}
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
        tagged: list[tuple[int, int, tuple[int, int], bool]] = []
        for citing, cited, infl in edge_results["refs"]:
            tagged.append((citing, cited, (citing, cited), infl))
        for citing, cited, infl in edge_results["cites"]:
            tagged.append((cited, citing, (citing, cited), infl))

        # Influential-only mode: drop every non-influential edge up front so the
        # papers they reach are never hydrated, added as nodes, or pushed onto the
        # frontier — i.e. not expanded from on later hops (admin toggle).
        if influential_only:
            tagged = [t for t in tagged if t[3]]

        # Candidate neighbours = endpoints not already known as nodes.
        candidates: set[int] = set()
        for _anchor, _neighbour, (citing, cited), _infl in tagged:
            for endpoint in (citing, cited):
                if endpoint not in nodes:
                    candidates.add(endpoint)
        hop_nodes = await _hydrate(list(candidates), hop=hop)

        # A neighbour is usable iff it is already a node or present in OpenSearch now,
        # and (when filtering) passes the active filter. Seeds are always exempt — they
        # were chosen by the user (and pre-filtered client-side for fields the index can't
        # supply, e.g. code/peer-reviewed/archetype). A non-usable node is excluded here,
        # so it is never added to `nodes`, never pushed onto `next_frontier`, and therefore
        # never expanded from on later hops — this gates BFS expansion for every filter.
        def _usable(cid: int) -> bool:
            node = nodes.get(cid) or hop_nodes.get(cid)
            if node is None:  # not in the index -> dropped (OpenSearch-only)
                return False
            if cid in seen_seed:
                return True
            if advanced_filtering:
                # Boolean query + metadata filter (the new path) supersedes the legacy one.
                if text_pred is not None and not text_pred(node.title, node.abstract):
                    return False
                if node_filter is not None and not node_matches_filter(node, node_filter):
                    return False
                return True
            if not include_non_matching:
                return matches_keywords(node.title, node.abstract, keywords)
            return True

        usable = [t for t in tagged if _usable(t[2][0]) and _usable(t[2][1])]

        # ok-score proxy: expanded neighbours are not ok-score-enriched, so their
        # ok-score is w_c·log10(1 + citation_count) — monotonic in citation_count —
        # and citation_count is the only signal available at expansion time.
        def _cite_count(cid: int) -> int:
            node = nodes.get(cid) or hop_nodes.get(cid)
            return (node.citation_count or 0) if node else -1

        # Per-paper top-K cap: keep only the top-K neighbours taken from any single
        # anchor paper (e.g. a foundational work's most relevant citers).
        # ``current_top_k`` was computed above (and may already have bounded the
        # BigQuery fetch); this trims to the exact top-K among usable neighbours.
        #
        # Ranking prioritises S2 "highly influential" citations: each anchor's
        # neighbours are partitioned influential-first (``t[3]``), then ordered within
        # each partition by ok-score (citation_count proxy). So an influential
        # neighbour is always kept ahead of a non-influential one, and only when the
        # partition still has room do non-influential neighbours fill the rest. A
        # descending tuple sort yields exactly that (True > False, then higher cite
        # count first); the stable sort keeps fetch order on exact ties. When
        # ``influential_only`` is set this is moot — non-influential edges are already
        # gone — so the partition collapses to a pure ok-score order.
        if current_top_k is not None:
            grouped: dict[int, list[tuple[int, int, tuple[int, int], bool]]] = defaultdict(list)
            for t in usable:
                grouped[t[0]].append(t)
            capped: list[tuple[int, int, tuple[int, int], bool]] = []
            for items in grouped.values():
                items.sort(key=lambda t: (t[3], _cite_count(t[1])), reverse=True)
                capped.extend(items[:current_top_k])
            usable = capped

        # Cumulative per-hop cap: across ALL frontier papers, add at most
        # ``max_per_hop_total`` *new* papers this hop so the graph cannot explode as the
        # frontier grows. Counts distinct new nodes (not edges); edges to papers that
        # don't make the cut are dropped, while edges to already-known papers are always
        # kept.
        #
        # Ranking mirrors the per-paper top-K above: influential-tier papers first, then
        # by ok-score (citation_count proxy). A new paper is influential-tier if *any* of
        # its incoming edges this hop is influential (OR-accumulated below), since the
        # cumulative cap ranks distinct papers while a paper may be reached by several
        # edges. A descending tuple sort yields True > False then higher cite count first;
        # the stable sort keeps insertion (fetch) order on exact ties for determinism.
        if max_per_hop_total is not None:
            new_infl: dict[int, bool] = {}
            for _anchor, neighbour, _edge, infl in usable:
                if neighbour in nodes:
                    continue
                new_infl[neighbour] = new_infl.get(neighbour, False) or infl
            if len(new_infl) > max_per_hop_total:
                kept_new = {
                    cid for cid, _ in sorted(
                        new_infl.items(),
                        key=lambda kv: (kv[1], _cite_count(kv[0])),
                        reverse=True,
                    )[:max_per_hop_total]
                }
                usable = [t for t in usable if t[1] in nodes or t[1] in kept_new]

        next_frontier: list[int] = []
        for _anchor, _neighbour, (citing, cited), infl in usable:
            key = (citing, cited)
            if key in edge_set:
                continue
            edge_set.add(key)
            for cid in (citing, cited):
                if cid not in nodes:
                    nodes[cid] = hop_nodes[cid]
                    next_frontier.append(cid)
            edges.append(CitGraphEdge(source=str(citing), target=str(cited), is_influential=infl))

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
    influential_only: bool = False,
    boolean_query: str | None = None,
    node_filter: object | None = None,
    directional_split: bool = False,
) -> CitGraphResult:
    """Expand a citation graph from multiple seeds in a chosen direction, from hosted data.

    When ``directional_split`` (the v2 construction) is set and ``direction`` is
    ``'both'``, the graph is assembled as the **union of two direction-pure
    cones**: a pure future cone (citations only, every hop) and a pure past cone
    (references only, every hop). Because a single-direction traversal cannot mix
    citation and reference hops, no node in the union is reachable by a path that
    alternates the two — unlike the default (v1) ``'both'`` traversal, whose
    single frontier expands in both directions each hop. Per-hop / per-paper caps
    apply independently within each cone. For a single-direction request v2 is
    identical to v1, so the split only takes effect for ``'both'``.
    """
    if directional_split and direction == "both":
        past = await _traverse(
            seeds,
            "past",
            k,
            _EXPLORE_FETCH_CAP,
            keywords or [],
            include_non_matching,
            top_k_per_paper=top_k_per_paper,
            max_per_hop_total=max_per_hop,
            influential_only=influential_only,
            boolean_query=boolean_query,
            node_filter=node_filter,
        )
        future = await _traverse(
            seeds,
            "future",
            k,
            _EXPLORE_FETCH_CAP,
            keywords or [],
            include_non_matching,
            top_k_per_paper=top_k_per_paper,
            max_per_hop_total=max_per_hop,
            influential_only=influential_only,
            boolean_query=boolean_query,
            node_filter=node_filter,
        )
        return merge_cit_graph_results(past, future)

    return await _traverse(
        seeds,
        direction,
        k,
        _EXPLORE_FETCH_CAP,
        keywords or [],
        include_non_matching,
        top_k_per_paper=top_k_per_paper,
        max_per_hop_total=max_per_hop,
        influential_only=influential_only,
        boolean_query=boolean_query,
        node_filter=node_filter,
    )

