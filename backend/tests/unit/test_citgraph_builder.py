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
    UpstreamError,
    build_citation_graph,
    explore_citation_graph,
    matches_keywords,
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
    def __init__(self, edges: list[tuple[int, int]], *, raise_=False):
        self._edges = edges
        self._raise = raise_

    def references(self, corpusids, cap):
        if self._raise:
            raise BigQueryCitationsError("bq down")
        s = set(corpusids)
        return [(a, b) for (a, b) in self._edges if a in s][: cap * len(s) or None]

    def citations(self, corpusids, cap):
        if self._raise:
            raise BigQueryCitationsError("bq down")
        s = set(corpusids)
        return [(a, b) for (a, b) in self._edges if b in s][: cap * len(s) or None]


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


