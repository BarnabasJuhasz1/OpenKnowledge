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


def _paper(cid: int, title: str = "", abstract: str | None = None) -> Paper:
    return Paper(
        semantic_scholar_id=str(cid),
        title=title or f"Paper {cid}",
        abstract=abstract,
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
