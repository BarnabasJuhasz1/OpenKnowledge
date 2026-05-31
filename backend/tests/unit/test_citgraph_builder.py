"""Unit tests for the citation graph builder normalization + BFS edge logic."""
from __future__ import annotations

import httpx
import pytest

from app.services.retrieval.citgraph_builder import (
    _looks_like_identifier,
    _normalize_node,
    build_citation_graph,
    CitGraphNode,
    UpstreamError,
)


class _FakeResp:
    def __init__(self, status_code, headers=None, payload=None):
        self.status_code = status_code
        self.headers = headers or {}
        self._payload = payload or {}

    def json(self):
        return self._payload


class _FakeClient:
    """Returns queued responses (or raises queued exceptions) on each GET."""

    def __init__(self, results):
        self._results = list(results)
        self.calls = 0

    async def get(self, url, params=None, headers=None):
        self.calls += 1
        result = self._results[min(self.calls - 1, len(self._results) - 1)]
        if isinstance(result, Exception):
            raise result
        return result


@pytest.mark.parametrize(
    "value,expected",
    [
        ("10.1145/3292500.3330919", True),  # DOI
        ("204e3073870fae3d05bcbc2f6a8e263d9b72e776", True),  # S2 hash
        ("ARXIV:2103.00020", True),
        ("SEED", True),  # single token -> id
        ("Attention Is All You Need", False),  # title
        ("  Deep Residual Learning  ", False),
        ("", False),
    ],
)
def test_looks_like_identifier(value, expected):
    assert _looks_like_identifier(value) is expected


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


@pytest.mark.asyncio
async def test_build_graph_resolves_title_seed(monkeypatch):
    """A free-text title seed is resolved to a paperId via the match endpoint."""
    import app.services.retrieval.citgraph_builder as mod

    seed = {"paperId": "SEED", "externalIds": {}, "title": "Seed Paper", "authors": []}
    matched_ids: list[str] = []

    async def fake_match_title(client, title, api_key):
        matched_ids.append(title)
        return "SEED"

    async def fake_fetch_paper(client, pid, api_key):
        assert pid == "SEED"  # must use the resolved id, not the raw title
        return seed

    async def fake_fetch_refs_and_cits(client, pid, api_key):
        return ([], [])

    monkeypatch.setattr(mod, "_match_title", fake_match_title)
    monkeypatch.setattr(mod, "_fetch_paper", fake_fetch_paper)
    monkeypatch.setattr(mod, "_fetch_refs_and_cits", fake_fetch_refs_and_cits)

    result = await build_citation_graph("Seed Paper", k=1, max_per_hop=20)

    assert matched_ids == ["Seed Paper"]
    assert {n.paper_id for n in result.nodes} == {"SEED"}


@pytest.mark.asyncio
async def test_get_with_retry_returns_none_on_404():
    """A genuine 404 means 'does not exist' and must stay distinct from errors."""
    import app.services.retrieval.citgraph_builder as mod

    client = _FakeClient([_FakeResp(404)])
    assert await mod._get_with_retry(client, "url", {}, {}) is None


@pytest.mark.asyncio
async def test_get_with_retry_raises_on_persistent_429(monkeypatch):
    """Exhausted rate-limit retries must raise, not masquerade as 'not found'."""
    import app.services.retrieval.citgraph_builder as mod

    async def _no_sleep(_):
        return None

    monkeypatch.setattr(mod.asyncio, "sleep", _no_sleep)
    client = _FakeClient([_FakeResp(429)])
    with pytest.raises(UpstreamError):
        await mod._get_with_retry(client, "url", {}, {}, max_retries=2)


@pytest.mark.asyncio
async def test_get_with_retry_raises_on_network_error():
    """A network error is transient, not a missing paper."""
    import app.services.retrieval.citgraph_builder as mod

    client = _FakeClient([httpx.ConnectError("boom")])
    with pytest.raises(UpstreamError):
        await mod._get_with_retry(client, "url", {}, {})


@pytest.mark.asyncio
async def test_build_graph_propagates_upstream_error_on_seed(monkeypatch):
    """A rate-limited seed fetch propagates UpstreamError (not an empty graph)."""
    import app.services.retrieval.citgraph_builder as mod

    async def boom(client, pid, api_key):
        raise UpstreamError("Semantic Scholar rate limit reached (HTTP 429).")

    monkeypatch.setattr(mod, "_fetch_paper", boom)

    with pytest.raises(UpstreamError):
        await build_citation_graph("SEED", k=1, max_per_hop=20)


@pytest.mark.asyncio
async def test_fetch_refs_and_cits_tolerates_upstream_error(monkeypatch):
    """A rate-limited neighbour fetch degrades to an empty list, not a crash."""
    import app.services.retrieval.citgraph_builder as mod

    async def boom(client, url, params, headers, max_retries=4):
        raise UpstreamError("rate limited")

    monkeypatch.setattr(mod, "_get_with_retry", boom)

    refs, cits = await mod._fetch_refs_and_cits(client=None, paper_id="X", api_key=None)
    assert refs == []
    assert cits == []


@pytest.mark.asyncio
async def test_fetch_refs_and_cits_handles_null_data(monkeypatch):
    """S2 can return {"data": null}; it must be coalesced to an empty list."""
    import app.services.retrieval.citgraph_builder as mod

    class _FakeResp:
        def json(self):
            return {"data": None}

    async def fake_get_with_retry(client, url, params, headers, max_retries=3):
        return _FakeResp()

    monkeypatch.setattr(mod, "_get_with_retry", fake_get_with_retry)

    refs, cits = await mod._fetch_refs_and_cits(client=None, paper_id="X", api_key=None)
    assert refs == []
    assert cits == []
