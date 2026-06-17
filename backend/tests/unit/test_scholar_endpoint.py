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
    def __init__(self, *, papers=None, raises=None, is_configured=True, iter_raises=None):
        self._papers = papers or []
        self._raises = raises
        self._iter_raises = iter_raises
        self.is_configured = is_configured
        self.last_query = None

    def search(self, boolean_query):
        self.last_query = boolean_query
        if self._raises is not None:
            raise self._raises
        return self._papers

    def iter_search(self, boolean_query):
        self.last_query = boolean_query
        for i, paper in enumerate(self._papers):
            # Optionally blow up partway through to exercise the in-band error line.
            if self._iter_raises is not None and i == self._iter_raises:
                raise OpenSearchSearchError("scroll boom")
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
