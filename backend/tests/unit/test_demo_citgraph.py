"""Unit tests for the demo-mode citation graph builder (no CSV / network)."""
from __future__ import annotations

import pytest

from app.services.retrieval.demo_citgraph import DemoCitGraphStore, _Index


def _make_store() -> DemoCitGraphStore:
    """A small synthetic index injected directly, bypassing the CSV build.

    Graph:
      seed cites A and B            (forward edges seed->A, seed->B)
      C and D cite seed             (reverse edges C->seed, D->seed)
      A cites E                     (used to test the 2nd hop)
      Z is referenced by seed but absent from meta (must be skipped)
    """
    meta = {
        pid: {
            "title": title,
            "abstract": f"Abstract for {title}",
            "authors": "['X']",
            "venue": "V",
            "year": "2020",
            "n_citation": cit,
            "predicted_main_archetype": "The Combiner" if pid == "seed" else "None",
            "predicted_second_tier_archetype": "Algorithm/Architecture" if pid == "seed" else "None",
        }
        for pid, title, cit in [
            ("seed", "A digital watermark", "1359"),
            ("A", "Alpha", "10"),
            ("B", "Beta", "5"),
            ("C", "Gamma", "3"),
            ("D", "Delta", "2"),
            ("E", "Epsilon", "1"),
            ("dup", "duplicate title", "9"),
            ("dup2", "duplicate title", "99"),
        ]
    }
    forward = {"seed": ["A", "B", "Z"], "A": ["E"]}
    reverse = {"seed": ["C", "D"], "E": ["A"], "A": ["seed"], "B": ["seed"]}
    title_to_id = {m["title"].lower(): pid for pid, m in meta.items() if pid != "dup2"}
    store = DemoCitGraphStore()
    store._index = _Index(forward, reverse, meta, title_to_id)
    return store


@pytest.mark.asyncio
async def test_resolves_title_case_insensitively():
    store = _make_store()
    result = await store.build("a DIGITAL watermark", k=1, max_per_hop=20)
    assert result.seed_id == "seed"


@pytest.mark.asyncio
async def test_resolves_raw_id():
    store = _make_store()
    result = await store.build("seed", k=1, max_per_hop=20)
    assert result.seed_id == "seed"


@pytest.mark.asyncio
async def test_edges_have_correct_direction_and_skip_missing():
    store = _make_store()
    result = await store.build("seed", k=1, max_per_hop=20)

    edges = {(e.source, e.target) for e in result.edges}
    # References: seed -> neighbour. Citations: neighbour -> seed.
    assert ("seed", "A") in edges
    assert ("seed", "B") in edges
    assert ("C", "seed") in edges
    assert ("D", "seed") in edges
    # Z is referenced by seed but has no meta row -> no node, no edge.
    assert all("Z" not in (e.source, e.target) for e in result.edges)
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "A", "B", "C", "D"}


@pytest.mark.asyncio
async def test_second_hop_expands_frontier():
    store = _make_store()
    result = await store.build("seed", k=2, max_per_hop=20)
    node_ids = {n.paper_id for n in result.nodes}
    # A cites E, so E appears at hop 2.
    assert "E" in node_ids
    assert {n.hop for n in result.nodes if n.paper_id == "E"} == {2}


@pytest.mark.asyncio
async def test_max_per_hop_caps_neighbours():
    store = _make_store()
    result = await store.build("seed", k=1, max_per_hop=1)
    # 1 reference (A) + 1 citation (C) + the seed itself.
    assert len(result.nodes) == 3


@pytest.mark.asyncio
async def test_missing_seed_returns_empty():
    store = _make_store()
    result = await store.build("no such paper anywhere", k=1, max_per_hop=20)
    assert result.nodes == []
    assert result.edges == []


@pytest.mark.asyncio
async def test_substring_fallback_picks_most_cited():
    store = _make_store()
    # "duplicate title" matches dup (9) and dup2 (99); highest n_citation wins.
    result = await store.build("duplicate", k=1, max_per_hop=20)
    assert result.seed_id == "dup2"


@pytest.mark.asyncio
async def test_node_fields_populated():
    store = _make_store()
    result = await store.build("seed", k=1, max_per_hop=20)
    seed_node = next(n for n in result.nodes if n.paper_id == "seed")
    assert seed_node.title == "A digital watermark"
    assert seed_node.abstract == "Abstract for A digital watermark"
    assert seed_node.citation_count == 1359
    assert seed_node.year == 2020
    assert seed_node.authors == ["X"]
    assert seed_node.reference_count == 3  # seed forward = [A, B, Z]
    assert seed_node.predicted_main_archetype == "The Combiner"
    assert seed_node.predicted_second_tier_archetype == "Algorithm/Architecture"

    a_node = next(n for n in result.nodes if n.paper_id == "A")
    assert a_node.predicted_main_archetype is None
    assert a_node.predicted_second_tier_archetype is None


@pytest.mark.asyncio
async def test_blank_abstract_becomes_none():
    store = _make_store()
    store._index.meta["seed"]["abstract"] = ""
    result = await store.build("seed", k=1, max_per_hop=20)
    seed_node = next(n for n in result.nodes if n.paper_id == "seed")
    assert seed_node.abstract is None
