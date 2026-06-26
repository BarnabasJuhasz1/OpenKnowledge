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
    # Archetypes present in the demo dataset are used as-is; nodes without one are
    # left unset for the API-layer classifier to fill in.
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


@pytest.mark.asyncio
async def test_explore_past():
    store = _make_store()
    result = await store.explore(["seed"], direction="past", include_non_matching=True)
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "A", "B"}
    edges = {(e.source, e.target) for e in result.edges}
    assert edges == {("seed", "A"), ("seed", "B")}


@pytest.mark.asyncio
async def test_explore_future():
    store = _make_store()
    result = await store.explore(["seed"], direction="future", include_non_matching=True)
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "C", "D"}
    edges = {(e.source, e.target) for e in result.edges}
    assert edges == {("C", "seed"), ("D", "seed")}


@pytest.mark.asyncio
async def test_explore_both():
    store = _make_store()
    result = await store.explore(["seed"], direction="both", include_non_matching=True)
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "A", "B", "C", "D"}
    edges = {(e.source, e.target) for e in result.edges}
    assert edges == {("seed", "A"), ("seed", "B"), ("C", "seed"), ("D", "seed")}


@pytest.mark.asyncio
async def test_explore_keyword_filter():
    store = _make_store()
    # A matches "Alpha", B does not. So A is included, B is skipped.
    result = await store.explore(
        ["seed"], direction="past", include_non_matching=False, keywords=["alpha"]
    )
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "A"}
    edges = {(e.source, e.target) for e in result.edges}
    assert edges == {("seed", "A")}


@pytest.mark.asyncio
async def test_explore_max_per_hop_cumulative_demo():
    store = _make_store()
    # Seed cites A (10 citations) and B (5 citations).
    # explore with direction=past, k=1, max_per_hop=1 (cumulative).
    # Since max_per_hop=1, only A (10 citations) should be kept, and B (5 citations) should be capped.
    result = await store.explore(
        ["seed"], direction="past", include_non_matching=True, k=1, max_per_hop=1
    )
    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"seed", "A"}
    edges = {(e.source, e.target) for e in result.edges}
    assert edges == {("seed", "A")}


@pytest.mark.asyncio
async def test_explore_top_k_per_paper_per_hop_demo():
    store = _make_store()
    # A cites E (1) and dup (9)
    store._index.forward["A"] = ["E", "dup"]
    result = await store.explore(
        ["seed"], direction="past", include_non_matching=True, k=2, top_k_per_paper=[None, 1]
    )
    node_ids = {n.paper_id for n in result.nodes}
    assert "dup" in node_ids
    assert "E" not in node_ids





@pytest.mark.asyncio
async def test_explore_boolean_query_filters_demo_neighbours():
    """The advanced boolean query gates demo neighbours the same way the hosted path does."""
    store = _make_store()
    # seed -> A ("Alpha") and B ("Beta"); query keeps only A.
    result = await store.explore(
        ["seed"], "past", k=1, max_per_hop=100, boolean_query="alpha",
    )
    ids = {n.paper_id for n in result.nodes}
    assert "seed" in ids and "A" in ids
    assert "B" not in ids


@pytest.mark.asyncio
async def test_explore_node_filter_citation_min_demo():
    from app.api.citgraph import GraphNodeFilter

    store = _make_store()
    # seed -> A (n_citation 10) and B (5). citation_min=8 keeps only A.
    result = await store.explore(
        ["seed"], "past", k=1, max_per_hop=100,
        node_filter=GraphNodeFilter(citation_min=8),
    )
    ids = {n.paper_id for n in result.nodes}
    assert "seed" in ids and "A" in ids
    assert "B" not in ids


# --- v2: direction-pure cones (directional_split) ---------------------------------

def _make_v2_store() -> DemoCitGraphStore:
    """Synthetic index with mixed-path nodes, for the v2 cone-union tests.

    forward = references (p cites x), reverse = citers (x cites p). Around `seed`:
      future hop1: C cites seed; future hop2: CC cites C
      past   hop1: seed references R; past hop2: R references RR
      mixed:  C references M  (future-then-past) — v1 only
      mixed:  M2 cites R      (past-then-future) — v1 only
    """
    ids = ["seed", "C", "R", "CC", "RR", "M", "M2"]
    meta = {
        pid: {
            "title": pid,
            "abstract": f"Abstract for {pid}",
            "authors": "['X']",
            "venue": "V",
            "year": "2020",
            "n_citation": "10",
            "predicted_main_archetype": "None",
            "predicted_second_tier_archetype": "None",
        }
        for pid in ids
    }
    forward = {"seed": ["R"], "C": ["seed", "M"], "R": ["RR"], "CC": ["C"], "M2": ["R"]}
    reverse = {"seed": ["C"], "R": ["seed", "M2"], "C": ["CC"], "M": ["C"], "RR": ["R"]}
    title_to_id = {m["title"].lower(): pid for pid, m in meta.items()}
    store = DemoCitGraphStore()
    store._index = _Index(forward, reverse, meta, title_to_id)
    return store


@pytest.mark.asyncio
async def test_v1_both_includes_mixed_path_nodes_demo():
    store = _make_v2_store()
    result = await store.explore(["seed"], direction="both", k=2)
    ids = {n.paper_id for n in result.nodes}
    # Default (v1) mixed expansion reaches M and M2 via mixed paths.
    assert ids == {"seed", "C", "R", "CC", "RR", "M", "M2"}


@pytest.mark.asyncio
async def test_v2_both_excludes_mixed_path_nodes_demo():
    store = _make_v2_store()
    result = await store.explore(["seed"], direction="both", k=2, directional_split=True)
    ids = {n.paper_id for n in result.nodes}
    assert ids == {"seed", "C", "R", "CC", "RR"}
    assert "M" not in ids and "M2" not in ids


@pytest.mark.asyncio
async def test_v2_equals_union_of_past_and_future_demo():
    store = _make_v2_store()
    v2 = await store.explore(["seed"], direction="both", k=2, directional_split=True)
    past = await store.explore(["seed"], direction="past", k=2)
    future = await store.explore(["seed"], direction="future", k=2)
    union_nodes = {n.paper_id for n in past.nodes} | {n.paper_id for n in future.nodes}
    union_edges = {(e.source, e.target) for e in past.edges} | {
        (e.source, e.target) for e in future.edges
    }
    assert {n.paper_id for n in v2.nodes} == union_nodes
    assert {(e.source, e.target) for e in v2.edges} == union_edges
