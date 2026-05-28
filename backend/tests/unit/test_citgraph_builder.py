"""Unit tests for the citation graph builder normalization + BFS edge logic."""
from __future__ import annotations

import pytest

from app.services.retrieval.citgraph_builder import (
    _normalize_node,
    build_citation_graph,
    CitGraphNode,
)


def test_normalize_node_basic():
    data = {
        "paperId": "abc123",
        "externalIds": {"DOI": "10.1/x", "ArXiv": "2401.00001"},
        "title": "Deep Citation Networks",
        "abstract": "An abstract.",
        "year": 2023,
        "citationCount": 42,
        "referenceCount": 17,
        "authors": [{"name": "Jane Doe"}, {"name": "John Roe"}],
        "journal": {"name": "Nature"},
        "isOpenAccess": True,
        "openAccessPdf": {"url": "http://example.com/p.pdf"},
        "fieldsOfStudy": ["Computer Science"],
    }
    node = _normalize_node(data, hop=1)
    assert isinstance(node, CitGraphNode)
    assert node.paper_id == "abc123"
    assert node.doi == "10.1/x"
    assert node.arxiv_id == "2401.00001"
    assert node.title == "Deep Citation Networks"
    assert node.citation_count == 42
    assert node.reference_count == 17
    assert node.authors == ["Jane Doe", "John Roe"]
    assert node.journal == "Nature"
    assert node.is_open_access is True
    assert node.pdf_url == "http://example.com/p.pdf"
    assert node.hop == 1


def test_normalize_node_missing_id_returns_none():
    assert _normalize_node({"title": "no id"}, hop=0) is None


def test_normalize_node_handles_missing_fields():
    node = _normalize_node({"paperId": "x"}, hop=2)
    assert node is not None
    assert node.title == ""
    assert node.authors == []
    assert node.journal is None
    assert node.is_open_access is False


@pytest.mark.asyncio
async def test_build_graph_with_mocked_fetch(monkeypatch):
    """k=1 BFS should produce seed + neighbors and correct edge directions."""
    import app.services.retrieval.citgraph_builder as mod

    seed = {
        "paperId": "SEED",
        "externalIds": {},
        "title": "Seed Paper",
        "year": 2020,
        "authors": [],
    }
    ref_paper = {"paperId": "REF1", "title": "Older Ref", "year": 2015, "authors": []}
    cit_paper = {"paperId": "CIT1", "title": "Newer Citer", "year": 2022, "authors": []}

    async def fake_fetch_paper(client, pid, api_key):
        return seed

    async def fake_fetch_refs_and_cits(client, pid, api_key):
        # seed references REF1; CIT1 cites seed
        return ([{"citedPaper": ref_paper}], [{"citingPaper": cit_paper}])

    monkeypatch.setattr(mod, "_fetch_paper", fake_fetch_paper)
    monkeypatch.setattr(mod, "_fetch_refs_and_cits", fake_fetch_refs_and_cits)

    result = await build_citation_graph("SEED", k=1, max_per_hop=20)

    node_ids = {n.paper_id for n in result.nodes}
    assert node_ids == {"SEED", "REF1", "CIT1"}
    assert result.seed_id == "SEED"

    edge_pairs = {(e.source, e.target) for e in result.edges}
    # seed -> ref means seed cites ref
    assert ("SEED", "REF1") in edge_pairs
    # citer -> seed means citer cites seed
    assert ("CIT1", "SEED") in edge_pairs
