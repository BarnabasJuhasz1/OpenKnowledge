"""Unit tests for the advanced OK-Graph build filters (boolean query + metadata).

Exercises the new traversal gating in ``citgraph_builder._traverse``: a non-matching
neighbour must be dropped *and* never expanded from on later hops. Reuses the fake
OpenSearch engine / BigQuery client from ``test_citgraph_builder``.
"""
from __future__ import annotations

import pytest

import app.services.retrieval.citgraph_builder as mod
from app.api.citgraph import GraphNodeFilter
from app.models.paper import Author, Paper
from app.services.retrieval.citgraph_builder import explore_citation_graph
from tests.unit.test_citgraph_builder import _FakeBQ, _FakeEngine, _wire


def _paper(
    cid: int,
    *,
    title: str = "",
    abstract: str | None = None,
    citation_count: int | None = None,
    year: int | None = None,
    is_open_access: bool = False,
    fields_of_study: list[str] | None = None,
) -> Paper:
    return Paper(
        semantic_scholar_id=str(cid),
        title=title or f"Paper {cid}",
        abstract=abstract,
        citation_count=citation_count,
        year=year,
        is_open_access=is_open_access,
        fields_of_study=fields_of_study or [],
        authors=[Author(name="A. Researcher")],
    )


# ── Boolean query ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_boolean_query_drops_non_matching_neighbour(monkeypatch):
    papers = {
        100: _paper(100, title="seed"),
        200: _paper(200, title="transformer efficiency"),
        300: _paper(300, title="unrelated survey"),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        boolean_query='"transformer efficiency"',
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}
    assert {(e.source, e.target) for e in result.edges} == {("100", "200")}


@pytest.mark.asyncio
async def test_boolean_query_blocks_expansion_through_dropped_node(monkeypatch):
    """A dropped 1-hop neighbour is never expanded, so its 2-hop-only child
    (which would otherwise match) never appears."""
    papers = {
        100: _paper(100, title="seed alpha"),
        200: _paper(200, title="alpha method"),      # hop1: matches -> kept + expanded
        300: _paper(300, title="beta only"),          # hop1: no match -> dropped
        400: _paper(400, title="alpha downstream"),    # hop2 via 200 -> reached
        500: _paper(500, title="alpha buried"),        # hop2 via dropped 300 -> never reached
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (200, 400), (300, 500)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "past", k=2, max_per_hop=100, boolean_query="alpha",
    )
    ids = {n.paper_id for n in result.nodes}
    assert ids == {"100", "200", "400"}
    assert "300" not in ids and "500" not in ids


@pytest.mark.asyncio
async def test_boolean_query_and_or_not(monkeypatch):
    papers = {
        100: _paper(100, title="seed"),
        200: _paper(200, title="graph neural network"),
        300: _paper(300, title="graph survey"),  # has 'graph' but also 'survey'
        400: _paper(400, title="neural network"),  # no 'graph'
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (100, 400)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        boolean_query="graph NOT survey",
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


# ── Metadata node_filter ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_node_filter_year_range(monkeypatch):
    papers = {
        100: _paper(100, year=2021),
        200: _paper(200, year=2020),
        300: _paper(300, year=2010),
        400: _paper(400, year=None),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (100, 400)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        node_filter=GraphNodeFilter(year_min=2018, year_max=2022),
    )
    # 300 (too old) and 400 (no year, fails a set bound) dropped; seed always kept.
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


@pytest.mark.asyncio
async def test_node_filter_citation_min(monkeypatch):
    papers = {
        100: _paper(100, citation_count=5),
        200: _paper(200, citation_count=100),
        300: _paper(300, citation_count=2),
        400: _paper(400, citation_count=None),  # treated as 0
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (100, 400)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        node_filter=GraphNodeFilter(citation_min=10),
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


@pytest.mark.asyncio
async def test_node_filter_open_access(monkeypatch):
    papers = {
        100: _paper(100),
        200: _paper(200, is_open_access=True),
        300: _paper(300, is_open_access=False),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        node_filter=GraphNodeFilter(open_access_only=True),
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


@pytest.mark.asyncio
async def test_node_filter_fields_of_study(monkeypatch):
    papers = {
        100: _paper(100),
        200: _paper(200, fields_of_study=["Computer Science"]),
        300: _paper(300, fields_of_study=["Biology"]),
        400: _paper(400, fields_of_study=[]),
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (100, 400)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        node_filter=GraphNodeFilter(fields=["Computer Science"]),
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


@pytest.mark.asyncio
async def test_boolean_query_and_node_filter_combined(monkeypatch):
    papers = {
        100: _paper(100, title="seed"),
        200: _paper(200, title="transformer", year=2021),  # matches both
        300: _paper(300, title="transformer", year=2010),  # matches query, fails year
        400: _paper(400, title="survey", year=2021),        # fails query
    }
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (100, 300), (100, 400)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        boolean_query="transformer",
        node_filter=GraphNodeFilter(year_min=2018),
    )
    assert {n.paper_id for n in result.nodes} == {"100", "200"}


@pytest.mark.asyncio
async def test_seed_never_dropped_even_if_it_fails_filter(monkeypatch):
    """Seeds are exempt from the filter (chosen by the user / pre-filtered client-side)."""
    papers = {100: _paper(100, title="unrelated", year=1990)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(
        ["S"], "both", k=1, max_per_hop=100,
        boolean_query="transformer",
        node_filter=GraphNodeFilter(year_min=2020),
    )
    assert {n.paper_id for n in result.nodes} == {"100"}


@pytest.mark.asyncio
async def test_no_filter_is_unchanged_regression(monkeypatch):
    papers = {100: _paper(100), 200: _paper(200), 300: _paper(300)}
    engine = _FakeEngine({"S": 100}, papers)
    bq = _FakeBQ([(100, 200), (300, 100)])
    _wire(monkeypatch, engine, bq)

    result = await explore_citation_graph(["S"], "both", k=1, max_per_hop=100)
    assert {n.paper_id for n in result.nodes} == {"100", "200", "300"}
    assert {(e.source, e.target) for e in result.edges} == {("100", "200"), ("300", "100")}
