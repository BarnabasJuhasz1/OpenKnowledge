"""Unit tests for the hosted citation graph builder (OpenSearch nodes + BigQuery edges).

No public Semantic Scholar API is involved anymore: the OpenSearch engine and the BigQuery
edge client are both faked, so these tests pin the traversal / edge-direction / filtering logic.
"""
from __future__ import annotations

import pytest

import app.services.retrieval.citgraph_builder as mod
from app.models.paper import Author, Paper
from app.services.retrieval.bigquery_citations import BigQueryCitationsError
from app.services.retrieval.citgraph_builder import (
    CitGraphEdge,
    CitGraphNode,
    CitGraphResult,
    UpstreamError,
    build_citation_graph,
    explore_citation_graph,
    matches_keywords,
    merge_cit_graph_results,
)
from app.services.retrieval.opensearch_search import OpenSearchSearchError


def _paper(
    cid: int,
    title: str = "",
    abstract: str | None = None,
    citation_count: int | None = None,
) -> Paper:
    return Paper(
        semantic_scholar_id=str(cid),
        title=title or f"Paper {cid}",
        abstract=abstract,
        citation_count=citation_count,
        authors=[Author(name="A. Researcher")],
    )


class _FakeEngine:
    def __init__(self, resolve: dict[str, int], papers: dict[int, Paper], *, raise_on=None):
        self._resolve = resolve
        self._papers = papers
        self._raise_on = raise_on  # 'resolve' | 'fetch' | None

    def resolve_corpusids(self, seeds):
        if self._raise_on == "resolve":
            raise OpenSearchSearchError("boom")
        return {s: self._resolve[s] for s in seeds if s in self._resolve}

    def fetch_nodes_by_corpusid(self, corpusids):
        if self._raise_on == "fetch":
            raise OpenSearchSearchError("boom")
        return {c: self._papers[c] for c in corpusids if c in self._papers}


class _FakeBQ:
    def __init__(self, edges, *, raise_=False):
        # Accept 2-tuples ``(citing, cited)`` or 3-tuples ``(citing, cited, is_influential)``;
        # normalise to triples so the provider contract (citing, cited, is_influential) holds.
        self._edges = [e if len(e) == 3 else (e[0], e[1], False) for e in edges]
        self._raise = raise_

    def references(self, corpusids, cap):
        if self._raise:
            raise BigQueryCitationsError("bq down")
        s = set(corpusids)
        return [(a, b, f) for (a, b, f) in self._edges if a in s][: cap * len(s) or None]

    def citations(self, corpusids, cap):
        if self._raise:
            raise BigQueryCitationsError("bq down")
        s = set(corpusids)
        return [(a, b, f) for (a, b, f) in self._edges if b in s][: cap * len(s) or None]


class _CapRecordingBQ(_FakeBQ):
    """Like _FakeBQ but records the per-source ``cap`` passed to each lookup."""

    def __init__(self, edges):
        super().__init__(edges)
        self.ref_caps: list[int] = []
        self.cite_caps: list[int] = []

    def references(self, corpusids, cap):
        self.ref_caps.append(cap)
        return super().references(corpusids, cap)

    def citations(self, corpusids, cap):
        self.cite_caps.append(cap)
        return super().citations(corpusids, cap)


def _wire(monkeypatch, engine, bq):
    monkeypatch.setattr(mod, "get_engine", lambda: engine)
    monkeypatch.setattr(mod, "get_citation_graph", lambda: bq)


def test_matches_keywords():
    assert matches_keywords("Deep Learning", None, []) is True  # no keywords => all match
    assert matches_keywords("Deep Learning", None, ["deep"]) is True
    assert matches_keywords("Graphs", "about nodes", ["edge"]) is False


@pytest.mark.asyncio
async def test_build_k1_seed_ref_and_citer(monkeypatch):
    """k=1 build: seed cites 200 (ref) and 300 cites seed (citer); edge directions correct."""
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"SEED": 100}, papers)
    bq = _FakeBQ([(100, 200), (300, 100)])  # source cites target
    _wire(monkeypatch, engine, bq)

    result = await build_citation_graph("SEED", k=1, max_per_hop=20)

    assert {n.paper_id for n in result.nodes} == {"100", "200", "300"}
    assert result.seed_id == "100"
    pairs = {(e.source, e.target) for e in result.edges}
    assert pairs == {("100", "200"), ("300", "100")}


@pytest.mark.asyncio
async def test_is_influential_flag_propagates_to_edges(monkeypatch):
    """The per-edge S2 ``isinfluential`` flag flows from the provider onto CitGraphEdge."""
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"SEED": 100}, papers)
    # (100->200) is influential; (300->100) is not.
    bq = _FakeBQ([(100, 200, True), (300, 100, False)])
    _wire(monkeypatch, engine, bq)

    result = await build_citation_graph("SEED", k=1, max_per_hop=20)

    flags = {(e.source, e.target): e.is_influential for e in result.edges}
    assert flags == {("100", "200"): True, ("300", "100"): False}


@pytest.mark.asyncio
async def test_influential_only_drops_non_influential_edges(monkeypatch):
    """influential_only keeps only influential edges + their endpoints."""
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"S": 100}, papers)
    # seed cites 200 (influential); 300 cites seed (not influential).
    bq = _FakeBQ([(100, 200, True), (300, 100, False)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=20, influential_only=True
    )
    # 300 came in only via a non-influential edge -> dropped node + edge.
    assert {n.paper_id for n in result.nodes} == {"100", "200"}
    assert {(e.source, e.target) for e in result.edges} == {("100", "200")}


@pytest.mark.asyncio
async def test_influential_only_blocks_expansion_on_later_hops(monkeypatch):
    """A non-influential first-hop neighbour is not expanded, so its own
    neighbours never appear on the second hop."""
    papers = {cid: _paper(cid) for cid in (100, 200, 300, 400, 500)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([
        (100, 200, True),    # hop 1: influential -> kept + expanded
        (100, 300, False),   # hop 1: non-influential -> dropped, never expanded
        (200, 400, True),    # hop 2: reached via influential 200 -> kept
        (300, 500, True),    # hop 2: would hang off dropped 300 -> never reached
    ])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "past", k=2, max_per_hop=100, influential_only=True
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200", "400"}
    pairs = {(e.source, e.target) for e in result.edges}
    assert pairs == {("100", "200"), ("200", "400")}
    assert "300" not in {n.paper_id for n in result.nodes}
    assert "500" not in {n.paper_id for n in result.nodes}


@pytest.mark.asyncio
async def test_influential_only_default_keeps_all_edges(monkeypatch):
    """Default (influential_only=False) is unchanged: non-influential edges stay."""
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200, True), (300, 100, False)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(["S"], "both", k=1, max_per_hop=20)
    assert {n.paper_id for n in result.nodes} == {"100", "200", "300"}
    assert {(e.source, e.target) for e in result.edges} == {("100", "200"), ("300", "100")}


@pytest.mark.asyncio
async def test_explore_direction_past_only(monkeypatch):
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (300, 100)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(["S"], "past", k=1, max_per_hop=20)
    assert {n.paper_id for n in result.nodes} == {"100", "200"}  # citer 300 excluded
    assert {(e.source, e.target) for e in result.edges} == {("100", "200")}


@pytest.mark.asyncio
async def test_explore_direction_future_only(monkeypatch):
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (300, 100)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(["S"], "future", k=1, max_per_hop=20)
    assert {n.paper_id for n in result.nodes} == {"100", "300"}  # ref 200 excluded
    assert {(e.source, e.target) for e in result.edges} == {("300", "100")}


@pytest.mark.asyncio
async def test_neighbor_absent_from_opensearch_is_dropped(monkeypatch):
    """A neighbour missing from the index drops its node *and* the edge to it."""
    papers = {100: _paper(100), 300: _paper(300)}  # 200 not indexed
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (300, 100)])
    _wire(monkeypatch, engine, bq)

    result = await build_citation_graph("S", k=1, max_per_hop=20)
    assert {n.paper_id for n in result.nodes} == {"100", "300"}
    assert {(e.source, e.target) for e in result.edges} == {("300", "100")}


@pytest.mark.asyncio
async def test_keyword_filter_drops_non_matching_neighbours(monkeypatch):
    papers = {
        100: _paper(100, title="seed"),
        200: _paper(200, title="relevant edge work"),
        300: _paper(300, title="unrelated"),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", include_non_matching=False, keywords=["edge"], k=1, max_per_hop=20
    )
    # Seed always kept; 200 matches "edge"; 300 filtered out.
    assert {n.paper_id for n in result.nodes} == {"100", "200"}
    assert {(e.source, e.target) for e in result.edges} == {("100", "200")}


@pytest.mark.asyncio
async def test_top_k_per_paper_keeps_highest_cited_citers(monkeypatch):
    """A paper's citers are capped to the top-K by citation_count (ok-score proxy)."""
    papers = {
        100: _paper(100, citation_count=999),  # seed
        300: _paper(300, citation_count=5),
        400: _paper(400, citation_count=50),
        500: _paper(500, citation_count=1),
    }
    engine = _FakeEngine({"S": 100}, papers)
    # All three cite the seed (future direction): edges (citer, 100).
    bq = _FakeBQ([(300, 100), (400, 100), (500, 100)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "future", k=1, max_per_hop=100, top_k_per_paper=2
    )
    # Keep the 2 highest-cited citers (400=50, 300=5); drop 500=1.
    assert {n.paper_id for n in result.nodes} == {"100", "400", "300"}
    assert {(e.source, e.target) for e in result.edges} == {("400", "100"), ("300", "100")}


@pytest.mark.asyncio
async def test_top_k_prioritises_influential_over_higher_cited(monkeypatch):
    """An influential, low-citation citer is kept ahead of a non-influential,
    higher-citation one when top-K would otherwise pick by ok-score alone."""
    papers = {
        100: _paper(100, citation_count=999),  # seed
        300: _paper(300, citation_count=5),     # influential
        400: _paper(400, citation_count=50),    # NOT influential, higher cited
    }
    engine = _FakeEngine({"S": 100}, papers)
    # Both cite the seed (future): (300->100) influential, (400->100) not.
    bq = _FakeBQ([(300, 100, True), (400, 100, False)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "future", k=1, max_per_hop=100, top_k_per_paper=1
    )
    # top_k=1: the influential 300 wins over the higher-cited-but-not-influential 400.
    assert {n.paper_id for n in result.nodes} == {"100", "300"}
    assert {(e.source, e.target) for e in result.edges} == {("300", "100")}


@pytest.mark.asyncio
async def test_top_k_influential_then_ok_score_within_partition(monkeypatch):
    """Within each influence partition, ranking is still by citation count: the kept
    set is the highest-cited influential neighbours first, then top non-influential."""
    papers = {
        100: _paper(100, citation_count=999),  # seed
        200: _paper(200, citation_count=1),     # influential, low cite
        300: _paper(300, citation_count=80),    # influential, high cite
        400: _paper(400, citation_count=70),    # not influential, high cite
        500: _paper(500, citation_count=60),    # not influential, lower cite
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([
        (200, 100, True),
        (300, 100, True),
        (400, 100, False),
        (500, 100, False),
    ])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "future", k=1, max_per_hop=100, top_k_per_paper=3
    )
    # Both influential (300, 200) come first regardless of cite count, then the single
    # highest-cited non-influential (400). 500 is dropped.
    assert {n.paper_id for n in result.nodes} == {"100", "300", "200", "400"}
    assert {(e.source, e.target) for e in result.edges} == {
        ("300", "100"), ("200", "100"), ("400", "100"),
    }


@pytest.mark.asyncio
async def test_top_k_per_paper_none_keeps_all(monkeypatch):
    """top_k_per_paper=None preserves the unbounded behaviour."""
    papers = {
        100: _paper(100, citation_count=999),
        300: _paper(300, citation_count=5),
        400: _paper(400, citation_count=50),
        500: _paper(500, citation_count=1),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(300, 100), (400, 100), (500, 100)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "future", k=1, max_per_hop=100, top_k_per_paper=None
    )
    assert {n.paper_id for n in result.nodes} == {"100", "300", "400", "500"}


@pytest.mark.asyncio
async def test_cap_pushed_down_on_top_k_without_keywords(monkeypatch):
    """top_k + no keyword filter -> BigQuery cap = top_k * overfetch (not the wide fetch cap)."""
    monkeypatch.setenv("CITGRAPH_BQ_OVERFETCH", "5")
    papers = {100: _paper(100), 300: _paper(300, citation_count=5)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _CapRecordingBQ([(300, 100)])
    _wire(monkeypatch, engine, bq)

    await explore_citation_graph(["S"], "future", k=1, top_k_per_paper=3)
    assert bq.cite_caps == [15]  # 3 * 5, not _EXPLORE_FETCH_CAP


@pytest.mark.asyncio
async def test_cap_not_pushed_down_when_keyword_filtering(monkeypatch):
    """With keyword filtering active the wide fetch cap is kept (top-K is taken among matches)."""
    monkeypatch.setenv("CITGRAPH_BQ_OVERFETCH", "5")
    papers = {100: _paper(100), 300: _paper(300, title="edge", citation_count=5)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _CapRecordingBQ([(300, 100)])
    _wire(monkeypatch, engine, bq)

    await explore_citation_graph(
        ["S"], "future", include_non_matching=False, keywords=["edge"], k=1, top_k_per_paper=3
    )
    assert bq.cite_caps == [mod._EXPLORE_FETCH_CAP]


@pytest.mark.asyncio
async def test_cap_not_pushed_down_when_no_top_k(monkeypatch):
    """No per-paper top-K -> keep the wide fetch cap (user asked to keep all per paper)."""
    papers = {100: _paper(100), 300: _paper(300, citation_count=5)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _CapRecordingBQ([(300, 100)])
    _wire(monkeypatch, engine, bq)

    await explore_citation_graph(["S"], "future", k=1, top_k_per_paper=None)
    assert bq.cite_caps == [mod._EXPLORE_FETCH_CAP]


@pytest.mark.asyncio
async def test_no_resolvable_seed_returns_empty(monkeypatch):
    engine = _FakeEngine({}, {})  # nothing resolves
    _wire(monkeypatch, engine, _FakeBQ([]))
    result = await build_citation_graph("does-not-exist", k=1, max_per_hop=20)
    assert result.nodes == [] and result.edges == [] and result.seed_id == ""


@pytest.mark.asyncio
async def test_opensearch_failure_raises_upstream(monkeypatch):
    engine = _FakeEngine({"S": 100}, {100: _paper(100)}, raise_on="resolve")
    _wire(monkeypatch, engine, _FakeBQ([]))
    with pytest.raises(UpstreamError):
        await build_citation_graph("S", k=1, max_per_hop=20)


@pytest.mark.asyncio
async def test_bigquery_failure_raises_upstream(monkeypatch):
    engine = _FakeEngine({"S": 100}, {100: _paper(100)})
    _wire(monkeypatch, engine, _FakeBQ([], raise_=True))
    with pytest.raises(UpstreamError):
        await build_citation_graph("S", k=1, max_per_hop=20)


@pytest.mark.asyncio
async def test_explore_max_per_hop_cumulative(monkeypatch):
    """max_per_hop on explore is cumulative across all frontier papers."""
    papers = {
        100: _paper(100),
        200: _paper(200),
        300: _paper(300, citation_count=5),
        400: _paper(400, citation_count=50),
        500: _paper(500, citation_count=100),
        600: _paper(600, citation_count=1),
    }
    engine = _FakeEngine({"S1": 100, "S2": 200}, papers)
    bq = _FakeBQ([(100, 300), (100, 400), (200, 500), (200, 600)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S1", "S2"], "past", k=1, max_per_hop=2
    )
    # Seeds are kept: 100, 200.
    # Cumulative cap of 2 keeps: 500 (100 citations) and 400 (50 citations).
    assert {n.paper_id for n in result.nodes} == {"100", "200", "400", "500"}
    pairs = {(e.source, e.target) for e in result.edges}
    assert pairs == {("100", "400"), ("200", "500")}


@pytest.mark.asyncio
async def test_cumulative_cap_prioritises_influential(monkeypatch):
    """The cumulative per-hop cap ranks influential-tier new papers first, then by
    ok-score — same ordering as the per-paper top-K."""
    papers = {
        100: _paper(100),
        200: _paper(200),
        300: _paper(300, citation_count=5),    # influential, low cite
        400: _paper(400, citation_count=50),    # not influential
        500: _paper(500, citation_count=100),   # not influential, highest cite
        600: _paper(600, citation_count=1),
    }
    engine = _FakeEngine({"S1": 100, "S2": 200}, papers)
    # (100->300) is influential; the rest are not.
    bq = _FakeBQ([(100, 300, True), (100, 400), (200, 500), (200, 600)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S1", "S2"], "past", k=1, max_per_hop=2
    )
    # Cap of 2: influential 300 is kept despite only 5 citations; the remaining slot
    # goes to the highest-cited non-influential paper, 500 (100). 400 and 600 drop.
    assert {n.paper_id for n in result.nodes} == {"100", "200", "300", "500"}
    pairs = {(e.source, e.target) for e in result.edges}
    assert pairs == {("100", "300"), ("200", "500")}


# --- v2: direction-pure cones (directional_split) ---------------------------------

# Edge convention: source cites target. Around seed 100:
#   (300, 100)  300 cites seed         -> future hop 1
#   (100, 200)  seed references 200    -> past hop 1
#   (310, 300)  310 cites 300          -> future hop 2 (pure future)
#   (200, 210)  200 references 210     -> past hop 2 (pure past)
#   (300, 400)  300 references 400     -> MIXED (future-then-past): v1 only
#   (410, 200)  410 cites 200          -> MIXED (past-then-future): v1 only
_V2_EDGES = [(300, 100), (100, 200), (310, 300), (200, 210), (300, 400), (410, 200)]
_V2_PAPERS = {cid: _paper(cid) for cid in (100, 200, 210, 300, 310, 400, 410)}


@pytest.mark.asyncio
async def test_v1_both_includes_mixed_path_nodes(monkeypatch):
    """v1 (default): the single frontier expands both ways each hop, so papers
    reachable only via a mixed citation/reference path (400, 410) ARE included."""
    engine = _FakeEngine({"S": 100}, dict(_V2_PAPERS))
    _wire(monkeypatch, engine, _FakeBQ(list(_V2_EDGES)))

    result = await explore_citation_graph(["S"], "both", k=2, max_per_hop=100)
    assert {n.paper_id for n in result.nodes} == {
        "100", "200", "300", "210", "310", "400", "410"
    }


@pytest.mark.asyncio
async def test_v2_both_excludes_mixed_path_nodes(monkeypatch):
    """v2 (directional_split): union of a pure future cone and a pure past cone.
    The mixed-path papers 400/410 are absent; the pure-cone papers remain."""
    engine = _FakeEngine({"S": 100}, dict(_V2_PAPERS))
    _wire(monkeypatch, engine, _FakeBQ(list(_V2_EDGES)))

    result = await explore_citation_graph(
        ["S"], "both", k=2, max_per_hop=100, directional_split=True
    )
    ids = {n.paper_id for n in result.nodes}
    assert ids == {"100", "200", "210", "300", "310"}
    assert "400" not in ids and "410" not in ids
    pairs = {(e.source, e.target) for e in result.edges}
    assert pairs == {("300", "100"), ("100", "200"), ("310", "300"), ("200", "210")}


@pytest.mark.asyncio
async def test_v2_equals_union_of_past_and_future(monkeypatch):
    """v2 'both' equals the union of independent 'past' and 'future' builds."""
    engine = _FakeEngine({"S": 100}, dict(_V2_PAPERS))
    _wire(monkeypatch, engine, _FakeBQ(list(_V2_EDGES)))

    v2 = await explore_citation_graph(
        ["S"], "both", k=2, max_per_hop=100, directional_split=True
    )
    past = await explore_citation_graph(["S"], "past", k=2, max_per_hop=100)
    future = await explore_citation_graph(["S"], "future", k=2, max_per_hop=100)

    union_nodes = {n.paper_id for n in past.nodes} | {n.paper_id for n in future.nodes}
    union_edges = {(e.source, e.target) for e in past.edges} | {
        (e.source, e.target) for e in future.edges
    }
    assert {n.paper_id for n in v2.nodes} == union_nodes
    assert {(e.source, e.target) for e in v2.edges} == union_edges


@pytest.mark.asyncio
async def test_v2_single_direction_matches_v1(monkeypatch):
    """For a single-direction request, directional_split is a no-op (v2 == v1)."""
    engine = _FakeEngine({"S": 100}, dict(_V2_PAPERS))
    _wire(monkeypatch, engine, _FakeBQ(list(_V2_EDGES)))
    v1 = await explore_citation_graph(["S"], "future", k=2, max_per_hop=100)

    engine2 = _FakeEngine({"S": 100}, dict(_V2_PAPERS))
    _wire(monkeypatch, engine2, _FakeBQ(list(_V2_EDGES)))
    v2 = await explore_citation_graph(
        ["S"], "future", k=2, max_per_hop=100, directional_split=True
    )
    assert {n.paper_id for n in v1.nodes} == {n.paper_id for n in v2.nodes}


def test_merge_cit_graph_results_dedups_and_keeps_min_hop():
    """Merge unions nodes (min hop wins), OR-s edge influence, takes first seed_id."""
    a = CitGraphResult(
        nodes=[CitGraphNode(paper_id="1", hop=0), CitGraphNode(paper_id="2", hop=2)],
        edges=[CitGraphEdge(source="1", target="2", is_influential=False)],
        seed_id="1",
    )
    b = CitGraphResult(
        nodes=[CitGraphNode(paper_id="1", hop=0), CitGraphNode(paper_id="2", hop=1)],
        edges=[
            CitGraphEdge(source="1", target="2", is_influential=True),  # upgrades flag
            CitGraphEdge(source="2", target="3", is_influential=False),
        ],
        seed_id="",
    )
    merged = merge_cit_graph_results(a, b)
    by_id = {n.paper_id: n for n in merged.nodes}
    assert set(by_id) == {"1", "2"}
    assert by_id["2"].hop == 1  # smaller hop from b wins
    edge_flags = {(e.source, e.target): e.is_influential for e in merged.edges}
    assert edge_flags == {("1", "2"): True, ("2", "3"): False}
    assert merged.seed_id == "1"


@pytest.mark.asyncio
async def test_explore_top_k_per_paper_per_hop(monkeypatch):
    """top_k_per_paper accepts a list of limits applying per hop level."""
    papers = {
        100: _paper(100),
        300: _paper(300, citation_count=5),
        400: _paper(400, citation_count=50),
        500: _paper(500, citation_count=100),
        600: _paper(600, citation_count=1),
        700: _paper(700, citation_count=200),
        800: _paper(800, citation_count=2),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 300), (100, 400), (300, 500), (300, 600), (400, 700), (400, 800)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "past", k=2, top_k_per_paper=[None, 1]
    )
    assert {n.paper_id for n in result.nodes} == {"100", "300", "400", "500", "700"}
    pairs = {(e.source, e.target) for e in result.edges}
    assert ("100", "300") in pairs
    assert ("100", "400") in pairs
    assert ("300", "500") in pairs
    assert ("400", "700") in pairs
    assert ("300", "600") not in pairs
    assert ("400", "800") not in pairs


