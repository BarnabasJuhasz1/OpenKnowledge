"""Tests for OpenSearchEngine (mocked client — no live cluster needed)."""
from __future__ import annotations

import pytest

from app.services.retrieval.opensearch_search import (
    OpenSearchEngine,
    OpenSearchNotConfiguredError,
    OpenSearchSearchError,
)


class _FakeClient:
    def __init__(self, hits=None, raises=None, count=None, ping=True):
        self._hits = hits or []
        self._raises = raises
        self._count = count
        self._ping = ping
        self.last_index = None
        self.last_body = None

    def search(self, index=None, body=None):
        self.last_index = index
        self.last_body = body
        if self._raises is not None:
            raise self._raises
        return {"hits": {"hits": [{"_source": s} for s in self._hits]}}

    def count(self, index=None):
        if self._raises is not None:
            raise self._raises
        return {"count": self._count}

    def ping(self):
        return self._ping


def _make_engine(client, **kwargs):
    engine = OpenSearchEngine(url="http://os:9200", index="papers", **kwargs)
    engine._client = client
    return engine


def test_maps_hits_to_papers():
    src = {
        "corpusid": 7,
        "title": "Pruning Large Language Models",
        "abstract": "We compress models.",
        "year": 2024,
        "publicationdate": "2024-01-02",
        "citationcount": 5,
        "referencecount": 22,
        "is_open_access": True,
        "url": "https://ex.org/7",
        "journal": "JMLR",
        "authors": ["Grace Hopper", "Edsger Dijkstra"],
        "doi": "10.5/xyz",
        "arxiv_id": "2401.00007",
        "pubmed_id": "12345",
        "fields_of_study": ["Computer Science"],
        "publication_types": ["JournalArticle"],
    }
    engine = _make_engine(_FakeClient(hits=[src]), result_limit=10)

    papers = engine.search('"large language model" AND pruning')

    assert len(papers) == 1
    p = papers[0]
    assert p.title == "Pruning Large Language Models"
    assert p.semantic_scholar_id == "7"
    assert p.doi == "10.5/xyz"
    assert p.arxiv_id == "2401.00007"
    assert p.pubmed_id == "12345"
    assert p.citation_count == 5
    assert p.is_open_access is True
    assert p.journal == "JMLR"
    assert [a.name for a in p.authors] == ["Grace Hopper", "Edsger Dijkstra"]
    assert p.fields_of_study == ["Computer Science"]
    assert p.is_peer_reviewed is True
    assert p.sources == ["semantic_scholar"]


def test_forwards_compiled_dsl_and_size():
    engine = _make_engine(_FakeClient(hits=[]), result_limit=250)
    engine.search('LLM AND compression')
    body = engine._client.last_body
    assert engine._client.last_index == "papers"
    assert body["size"] == 250
    # AND of two terms -> bool/must with two should-clauses.
    assert body["query"]["bool"]["must"][0]["bool"]["should"][0]["match_phrase"]["title"] == "LLM"


def test_search_error_wrapped():
    engine = _make_engine(_FakeClient(raises=RuntimeError("connection refused")), result_limit=5)
    with pytest.raises(OpenSearchSearchError):
        engine.search("LLM")


def test_not_configured_raises():
    engine = OpenSearchEngine(url="")
    assert engine.is_configured is False
    with pytest.raises(OpenSearchNotConfiguredError):
        engine.search("LLM")


def test_searchable_count_returns_live_count():
    engine = _make_engine(_FakeClient(count=4242))
    assert engine.searchable_count() == 4242


def test_searchable_count_wraps_errors():
    engine = _make_engine(_FakeClient(raises=RuntimeError("connection refused")))
    with pytest.raises(OpenSearchSearchError):
        engine.searchable_count()


def test_ping_returns_client_ping():
    engine = _make_engine(_FakeClient(ping=True))
    assert engine.ping() is True


def test_client_built_with_timeout_and_retry(monkeypatch):
    """The lazily-built client must receive resilience kwargs (timeout/retry)."""
    captured = {}

    class _FakeOpenSearch:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import app.services.retrieval.opensearch_search as mod
    monkeypatch.setattr("opensearchpy.OpenSearch", _FakeOpenSearch, raising=False)

    engine = OpenSearchEngine(
        url="http://os:9200", timeout=30, max_retries=3, retry_on_timeout=True
    )
    engine._get_client()
    assert captured["hosts"] == ["http://os:9200"]
    assert captured["timeout"] == 30
    assert captured["max_retries"] == 3
    assert captured["retry_on_timeout"] is True


def test_connection_tuning_from_env(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_TIMEOUT", "55")
    monkeypatch.setenv("OPENSEARCH_MAX_RETRIES", "7")
    monkeypatch.setenv("OPENSEARCH_RETRY_ON_TIMEOUT", "false")
    engine = OpenSearchEngine(url="http://os:9200")
    assert engine.timeout == 55
    assert engine.max_retries == 7
    assert engine.retry_on_timeout is False


# ── result_limit resolution: unset/empty means UNLIMITED ──────────────────────

def test_unset_env_limit_is_unlimited(monkeypatch):
    monkeypatch.delenv("OPENSEARCH_RESULT_LIMIT", raising=False)
    assert OpenSearchEngine(url="http://os:9200").result_limit is None


def test_empty_env_limit_is_unlimited(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_RESULT_LIMIT", "")
    assert OpenSearchEngine(url="http://os:9200").result_limit is None


def test_positive_env_limit_parsed(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_RESULT_LIMIT", "250")
    assert OpenSearchEngine(url="http://os:9200").result_limit == 250


@pytest.mark.parametrize("bad", ["0", "-5", "abc"])
def test_nonpositive_or_invalid_env_limit_is_unlimited(monkeypatch, bad):
    monkeypatch.setenv("OPENSEARCH_RESULT_LIMIT", bad)
    assert OpenSearchEngine(url="http://os:9200").result_limit is None


def test_explicit_none_limit_overrides_env(monkeypatch):
    monkeypatch.setenv("OPENSEARCH_RESULT_LIMIT", "250")
    assert OpenSearchEngine(url="http://os:9200", result_limit=None).result_limit is None


# ── fast path vs scroll path ──────────────────────────────────────────────────

def test_finite_limit_uses_single_search():
    """A small finite limit goes through client.search with `size` (BM25 top-N)."""
    client = _FakeClient(hits=[{"corpusid": 1, "title": "a"}, {"corpusid": 2, "title": "b"}])
    engine = _make_engine(client, result_limit=50)
    papers = engine.search("neural")
    assert len(papers) == 2
    assert client.last_body["size"] == 50


def test_unlimited_streams_via_scan(monkeypatch):
    """No limit -> scroll/scan over the whole match set, not a capped search."""
    captured = {}

    def fake_scan(client, **kwargs):
        captured.update(kwargs)
        for i in range(3):
            yield {"_source": {"corpusid": i, "title": f"t{i}"}}

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    client = _FakeClient()
    engine = _make_engine(client, result_limit=None)
    papers = engine.search("neural")
    assert [p.semantic_scholar_id for p in papers] == ["0", "1", "2"]
    assert captured["index"] == "papers"
    assert captured["preserve_order"] is False
    assert client.last_body is None  # the single-search path was NOT used


def test_limit_over_window_caps_via_scan(monkeypatch):
    """A finite limit larger than the 10k window scrolls and stops at the cap."""
    def fake_scan(client, **kwargs):
        for i in range(50_000):
            yield {"_source": {"corpusid": i, "title": "x"}}

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    engine = _make_engine(_FakeClient(), result_limit=12_000)
    papers = engine.search("neural")
    assert len(papers) == 12_000


def test_scan_error_wrapped(monkeypatch):
    def fake_scan(client, **kwargs):
        raise RuntimeError("scroll boom")
        yield  # pragma: no cover

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    engine = _make_engine(_FakeClient(), result_limit=None)
    with pytest.raises(OpenSearchSearchError):
        engine.search("neural")


def test_iter_search_is_lazy(monkeypatch):
    """iter_search yields without materializing everything (constant-memory streaming)."""
    started = {"n": 0}

    def fake_scan(client, **kwargs):
        for i in range(10):
            started["n"] += 1
            yield {"_source": {"corpusid": i, "title": "x"}}

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    engine = _make_engine(_FakeClient(), result_limit=None)
    it = engine.iter_search("neural")
    first = next(it)
    assert first.semantic_scholar_id == "0"
    assert started["n"] == 1  # only one hit pulled so far
