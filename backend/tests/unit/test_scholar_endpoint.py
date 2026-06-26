"""Tests for the /retrieval/scholar/search endpoint (Semantic Scholar mode)."""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import scholar as scholar_api
from app.models.paper import Paper
from app.services.retrieval.opensearch_search import (
    OpenSearchNotConfiguredError,
    OpenSearchSearchError,
)


class _FakeEngine:
    def __init__(self, *, papers=None, raises=None, is_configured=True, iter_raises=None,
                 total=None, ranked_ids=None, papers_by_id=None):
        self._papers = papers or []
        self._raises = raises
        self._iter_raises = iter_raises
        self._total = total
        self._ranked_ids = ranked_ids or []
        self._papers_by_id = papers_by_id or {}
        self.is_configured = is_configured
        self.last_query = None
        self.last_limit = "<unset>"
        self.last_page_args = None
        self.last_ranked_args = None
        self.last_facet_filters = None

    def search_page(self, boolean_query, *, offset, size, sort="relevancy", filters=None):
        self.last_query = boolean_query
        self.last_page_args = {"offset": offset, "size": size, "sort": sort, "filters": filters}
        if self._raises is not None:
            raise self._raises
        total = self._total if self._total is not None else len(self._papers)
        page = self._papers[offset:offset + size] if size > 0 else []
        return page, total

    def ranked_corpusids(self, boolean_query, *, sort="relevancy", limit, filters=None):
        self.last_query = boolean_query
        self.last_ranked_args = {"sort": sort, "limit": limit, "filters": filters}
        if self._raises is not None:
            raise self._raises
        ids = list(self._ranked_ids)
        return ids[:limit], len(ids)

    def field_facets(self, boolean_query, *, filters=None):
        self.last_query = boolean_query
        self.last_facet_filters = filters
        if self._raises is not None:
            raise self._raises
        return {
            "fields": {"Computer Science": 12, "Physics": 3},
            "miscellaneous": 4,
            "total": 19,
            "year_min": 2001,
            "year_max": 2024,
        }

    def fetch_nodes_by_corpusid(self, corpusids):
        return {cid: self._papers_by_id[cid] for cid in corpusids if cid in self._papers_by_id}

    def search(self, boolean_query):  # legacy convenience; endpoints use iter_search now
        return list(self.iter_search(boolean_query))

    def iter_search(self, boolean_query, *, result_limit="<unset>"):
        self.last_query = boolean_query
        self.last_limit = result_limit
        if self._raises is not None:
            raise self._raises
        emitted = 0
        for i, paper in enumerate(self._papers):
            # Honour a finite cap so endpoint-level cap behaviour can be asserted.
            if isinstance(result_limit, int) and emitted >= result_limit:
                break
            # Optionally blow up partway through to exercise the in-band error line.
            if self._iter_raises is not None and i == self._iter_raises:
                raise OpenSearchSearchError("scroll boom")
            emitted += 1
            yield paper


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(scholar_api.router, prefix="/api")

    async def _noop(papers):
        return None

    monkeypatch.setattr(scholar_api.archetype, "classify_papers", _noop)
    return TestClient(app)


def _set_engine(monkeypatch, engine):
    monkeypatch.setattr(scholar_api, "get_engine", lambda: engine)


def test_happy_path_returns_papers(client, monkeypatch):
    engine = _FakeEngine(papers=[Paper(title="A LLM compression study")])
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/search", json={"keywords": ["LLM"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_found"] == 1
    assert body["sources_queried"] == ["semantic_scholar"]
    assert body["papers"][0]["title"] == "A LLM compression study"


def test_raw_boolean_query_is_passed_through(client, monkeypatch):
    engine = _FakeEngine(papers=[])
    _set_engine(monkeypatch, engine)

    raw = '"LLM" OR "Large Language Model" AND "compression" NOT "RAG"'
    resp = client.post(
        "/api/retrieval/scholar/search",
        json={"keywords": ["LLM"], "raw_query": raw},
    )
    assert resp.status_code == 200
    assert engine.last_query == raw
    assert resp.json()["queries_used"]["semantic_scholar"] == raw


def test_empty_request_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post("/api/retrieval/scholar/search", json={"keywords": []})
    assert resp.status_code == 422


def test_not_configured_is_503(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine(raises=OpenSearchNotConfiguredError("no url")))
    resp = client.post("/api/retrieval/scholar/search", json={"keywords": ["LLM"]})
    assert resp.status_code == 503


# ── NDJSON streaming endpoint ─────────────────────────────────────────────────

def _ndjson_lines(resp):
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


def test_stream_emits_papers_then_summary(client, monkeypatch):
    papers = [Paper(title="A"), Paper(title="B"), Paper(title="C")]
    engine = _FakeEngine(papers=papers)
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/search/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")

    records = _ndjson_lines(resp)
    paper_lines = [r for r in records if r["type"] == "paper"]
    summary = records[-1]
    assert [r["paper"]["title"] for r in paper_lines] == ["A", "B", "C"]
    assert summary["type"] == "summary"
    assert summary["total_found"] == 3
    assert summary["sources_queried"] == ["semantic_scholar"]


def test_stream_passes_raw_boolean_query(client, monkeypatch):
    engine = _FakeEngine(papers=[])
    _set_engine(monkeypatch, engine)
    raw = '"LLM" AND "compression" NOT "RAG"'

    resp = client.post(
        "/api/retrieval/scholar/search/stream",
        json={"keywords": ["LLM"], "raw_query": raw},
    )
    assert resp.status_code == 200
    assert engine.last_query == raw
    summary = _ndjson_lines(resp)[-1]
    assert summary["total_found"] == 0
    assert summary["queries_used"]["semantic_scholar"] == raw


def test_stream_empty_request_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post("/api/retrieval/scholar/search/stream", json={"keywords": []})
    assert resp.status_code == 422


def test_stream_not_configured_is_503(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine(is_configured=False))
    resp = client.post("/api/retrieval/scholar/search/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 503


def test_stream_invalid_boolean_query_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post(
        "/api/retrieval/scholar/search/stream",
        json={"keywords": ["LLM"], "raw_query": "a AND"},
    )
    assert resp.status_code == 422


def test_stream_midstream_error_emits_error_line(client, monkeypatch):
    papers = [Paper(title="A"), Paper(title="B"), Paper(title="C")]
    engine = _FakeEngine(papers=papers, iter_raises=2)  # fail after emitting 2
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/search/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 200  # stream already committed
    records = _ndjson_lines(resp)
    assert [r["type"] for r in records] == ["paper", "paper", "error"]
    assert "scroll boom" in records[-1]["detail"]


# ── field-of-study facets (/facets) ───────────────────────────────────────────

def test_facets_returns_field_counts_and_miscellaneous(client, monkeypatch):
    engine = _FakeEngine()
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/facets", json={"keywords": ["LLM"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"] == {"Computer Science": 12, "Physics": 3}
    assert body["miscellaneous"] == 4
    assert body["total"] == 19
    # Year bounds come from the whole match set so the slider isn't capped to the loaded page.
    assert body["year_min"] == 2001
    assert body["year_max"] == 2024


def test_facets_drops_field_and_archetype_filters(client, monkeypatch):
    """The facet query must ignore the field + archetype selection so the option list isn't
    pruned by the very selection it's meant to drive."""
    engine = _FakeEngine()
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/facets",
        json={
            "keywords": ["LLM"],
            "filters": {
                "fields_of_study": ["Physics"],
                "archetypes": ["The Analyst"],
                "year_min": 2020,
            },
        },
    )
    assert resp.status_code == 200
    assert engine.last_facet_filters.fields_of_study is None
    assert engine.last_facet_filters.archetypes is None
    # Other filters still apply.
    assert engine.last_facet_filters.year_min == 2020


def test_facets_empty_request_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post("/api/retrieval/scholar/facets", json={"keywords": []})
    assert resp.status_code == 422


def test_facets_not_configured_is_503(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine(raises=OpenSearchNotConfiguredError("no url")))
    resp = client.post("/api/retrieval/scholar/facets", json={"keywords": ["LLM"]})
    assert resp.status_code == 503


# ── safety cap (_effective_limit) ─────────────────────────────────────────────

def test_effective_limit_defaults_when_env_unset(monkeypatch):
    monkeypatch.delenv("SCHOLAR_MAX_RESULTS", raising=False)
    req = scholar_api.SearchRequest(keywords=["x"], max_total_results=None)
    assert scholar_api._effective_limit(req) == scholar_api._DEFAULT_SCHOLAR_MAX_RESULTS


@pytest.mark.parametrize("bad", ["", "0", "-3", "abc"])
def test_effective_limit_falls_back_on_bad_env(monkeypatch, bad):
    """The backstop must never resolve to unlimited, even with junk env values."""
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", bad)
    req = scholar_api.SearchRequest(keywords=["x"], max_total_results=None)
    assert scholar_api._effective_limit(req) == scholar_api._DEFAULT_SCHOLAR_MAX_RESULTS


def test_effective_limit_honours_env(monkeypatch):
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "500")
    req = scholar_api.SearchRequest(keywords=["x"], max_total_results=None)
    assert scholar_api._effective_limit(req) == 500


def test_effective_limit_client_can_request_fewer(monkeypatch):
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "500")
    req = scholar_api.SearchRequest(keywords=["x"], max_total_results=100)
    assert scholar_api._effective_limit(req) == 100


def test_effective_limit_client_cannot_exceed_backstop(monkeypatch):
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "500")
    req = scholar_api.SearchRequest(keywords=["x"], max_total_results=999_999)
    assert scholar_api._effective_limit(req) == 500


def test_buffered_search_applies_cap(client, monkeypatch):
    """The buffered endpoint must pass a finite cap into iter_search (no unbounded list)."""
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "2")
    papers = [Paper(title=t) for t in ("A", "B", "C", "D", "E")]
    engine = _FakeEngine(papers=papers)
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/search", json={"keywords": ["LLM"]})
    assert resp.status_code == 200
    assert engine.last_limit == 2
    assert resp.json()["total_found"] == 2  # capped, not all 5


def test_stream_applies_cap_and_reports_capped(client, monkeypatch):
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "2")
    papers = [Paper(title=t) for t in ("A", "B", "C", "D", "E")]
    engine = _FakeEngine(papers=papers)
    _set_engine(monkeypatch, engine)

    resp = client.post("/api/retrieval/scholar/search/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 200
    assert engine.last_limit == 2
    records = _ndjson_lines(resp)
    paper_lines = [r for r in records if r["type"] == "paper"]
    summary = records[-1]
    assert len(paper_lines) == 2
    assert summary["result_cap"] == 2
    assert summary["capped"] is True


# ── paginated endpoint (/search/page) ─────────────────────────────────────────

def test_page_returns_page_and_total(client, monkeypatch):
    papers = [Paper(title=t) for t in ("A", "B", "C")]
    engine = _FakeEngine(papers=papers, total=4242)
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={"keywords": ["LLM"], "page": 1, "page_size": 3},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_found"] == 4242
    assert body["page"] == 1 and body["page_size"] == 3
    assert [p["title"] for p in body["papers"]] == ["A", "B", "C"]
    assert body["has_more"] is True  # 3 returned < total 4242
    assert engine.last_page_args["offset"] == 0
    assert engine.last_page_args["size"] == 3


def test_page_offset_and_sort_filters_forwarded(client, monkeypatch):
    papers = [Paper(title=f"P{i}") for i in range(50)]
    engine = _FakeEngine(papers=papers, total=50)
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={
            "keywords": ["LLM"], "page": 3, "page_size": 10, "sort": "year_desc",
            "filters": {"year_min": 2020, "open_access_only": True},
        },
    )
    assert resp.status_code == 200
    args = engine.last_page_args
    assert args["offset"] == 20  # (3-1)*10
    assert args["size"] == 10
    assert args["sort"] == "year_desc"
    assert args["filters"].year_min == 2020
    assert args["filters"].open_access_only is True


def test_page_forwards_fields_of_study_filter(client, monkeypatch):
    papers = [Paper(title=f"P{i}") for i in range(5)]
    engine = _FakeEngine(papers=papers, total=5)
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={
            "keywords": ["LLM"], "page": 1, "page_size": 10,
            "filters": {"fields_of_study": ["Computer Science", "Medicine"]},
        },
    )
    assert resp.status_code == 200
    assert engine.last_page_args["filters"].fields_of_study == ["Computer Science", "Medicine"]


def test_page_beyond_cap_is_empty_but_reports_total(client, monkeypatch):
    monkeypatch.setenv("SCHOLAR_MAX_RESULTS", "50")
    papers = [Paper(title=f"P{i}") for i in range(50)]
    engine = _FakeEngine(papers=papers, total=9999)
    _set_engine(monkeypatch, engine)

    # page 2 @ size 50 -> offset 100, beyond the cap of 50.
    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={"keywords": ["LLM"], "page": 2, "page_size": 50},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["papers"] == []
    assert body["has_more"] is False
    assert body["total_found"] == 9999      # real total still surfaced
    assert body["result_cap"] == 50
    assert engine.last_page_args["size"] == 0  # nothing fetchable past the window


def test_page_has_more_false_on_last_page(client, monkeypatch):
    papers = [Paper(title=f"P{i}") for i in range(5)]
    engine = _FakeEngine(papers=papers, total=5)
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={"keywords": ["LLM"], "page": 1, "page_size": 10},
    )
    body = resp.json()
    assert len(body["papers"]) == 5
    assert body["has_more"] is False


def test_page_empty_request_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post("/api/retrieval/scholar/search/page", json={"keywords": []})
    assert resp.status_code == 422


def test_page_not_configured_is_503(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine(raises=OpenSearchNotConfiguredError("no url")))
    resp = client.post("/api/retrieval/scholar/search/page", json={"keywords": ["LLM"]})
    assert resp.status_code == 503


def test_classify_stream_emits_growing_distribution(client, monkeypatch):
    """The classify stream pages the match set and pushes a cumulative distribution."""
    papers = [
        Paper(title=f"p{i}", abstract="abstract text", citation_count=100 - i)
        for i in range(5)
    ]
    engine = _FakeEngine(papers=papers)
    _set_engine(monkeypatch, engine)
    # Small batch so 5 papers span 3 pages (2 + 2 + 1).
    monkeypatch.setattr(scholar_api, "_CLASSIFY_BATCH", 2)

    async def fake_classify(batch):
        for p in batch:
            p.predicted_main_archetype = "The Innovator"

    monkeypatch.setattr(scholar_api.archetype, "classify_papers", fake_classify)

    resp = client.post("/api/retrieval/scholar/classify/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 200

    lines = _ndjson_lines(resp)
    dist = [l for l in lines if l["type"] == "distribution"]
    arch = [l for l in lines if l["type"] == "archetypes"]
    done = [l for l in lines if l["type"] == "done"]

    # Cumulative classified counts grow 2 -> 4 -> 5 across the three batches.
    assert [d["classified"] for d in dist] == [2, 4, 5]
    assert dist[-1]["counts"]["The Innovator"] == 5
    assert dist[-1]["total"] == 5
    assert arch, "expected per-paper archetype events"
    assert len(done) == 1 and done[0]["classified"] == 5


def test_classify_stream_empty_request_is_422(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine())
    resp = client.post("/api/retrieval/scholar/classify/stream", json={"keywords": []})
    assert resp.status_code == 422


def test_classify_stream_not_configured_is_503(client, monkeypatch):
    _set_engine(monkeypatch, _FakeEngine(is_configured=False))
    resp = client.post("/api/retrieval/scholar/classify/stream", json={"keywords": ["LLM"]})
    assert resp.status_code == 503


# ── Server-side archetype filtering across the whole match set ──

def test_page_archetype_filter_uses_cache_across_match_set(client, monkeypatch):
    """An archetype subset filters the whole ranked match set via the classification cache,
    returning only matching papers (correct total) with archetypes patched on."""
    from app.services.archetype import cache as archetype_cache

    archetype_cache.clear()
    # Cache classifications for the ranked corpusids (as the classify stream would populate).
    archetype_cache.put(archetype_cache.corpusid_key(1), "The Innovator", None)
    archetype_cache.put(archetype_cache.corpusid_key(2), "The Evaluator", None)
    archetype_cache.put(archetype_cache.corpusid_key(3), None, "The Innovator")
    # cid 4 is ranked but never classified -> excluded from an archetype-filtered set.

    papers_by_id = {
        1: Paper(title="one", semantic_scholar_id="1"),
        2: Paper(title="two", semantic_scholar_id="2"),
        3: Paper(title="three", semantic_scholar_id="3"),
        4: Paper(title="four", semantic_scholar_id="4"),
    }
    engine = _FakeEngine(ranked_ids=[1, 2, 3, 4], papers_by_id=papers_by_id)
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={"keywords": ["LLM"], "filters": {"archetypes": ["The Innovator"]}},
    )
    assert resp.status_code == 200
    data = resp.json()

    # Only cids 1 (primary) and 3 (secondary) match The Innovator; 2 and 4 are excluded.
    assert data["total_found"] == 2
    titles = [p["title"] for p in data["papers"]]
    assert titles == ["one", "three"]
    assert data["papers"][0]["predicted_main_archetype"] == "The Innovator"
    assert data["papers"][1]["predicted_second_tier_archetype"] == "The Innovator"
    assert data["has_more"] is False
    # The ranked scan must drop the archetype constraint (the index can't express it).
    assert engine.last_ranked_args["filters"].archetypes is None

    archetype_cache.clear()


def test_page_without_archetype_filter_uses_index_path(client, monkeypatch):
    """No archetype subset -> the fast from/size index path (search_page), not the scan."""
    engine = _FakeEngine(papers=[Paper(title="A"), Paper(title="B")])
    _set_engine(monkeypatch, engine)

    resp = client.post(
        "/api/retrieval/scholar/search/page",
        json={"keywords": ["LLM"], "page_size": 10},
    )
    assert resp.status_code == 200
    assert engine.last_page_args is not None       # index path was taken
    assert engine.last_ranked_args is None         # scan path was not
