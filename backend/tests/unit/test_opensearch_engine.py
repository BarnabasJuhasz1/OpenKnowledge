"""Tests for OpenSearchEngine (mocked client — no live cluster needed)."""
from __future__ import annotations

import pytest

from app.services.retrieval.opensearch_search import (
    OpenSearchEngine,
    OpenSearchNotConfiguredError,
    OpenSearchSearchError,
)


class _FakeClient:
    def __init__(self, hits=None, raises=None, count=None, ping=True, total=None):
        self._hits = hits or []
        self._raises = raises
        self._count = count
        self._ping = ping
        self._total = total
        self.last_index = None
        self.last_body = None

    def search(self, index=None, body=None):
        self.last_index = index
        self.last_body = body
        if self._raises is not None:
            raise self._raises
        resp = {"hits": {"hits": [{"_source": s} for s in self._hits]}}
        if self._total is not None:
            resp["hits"]["total"] = {"value": self._total, "relation": "eq"}
        return resp

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
    # Archetype + code fields absent in this hit -> default-safe.
    assert p.has_public_code is None
    assert p.has_dataset is False
    assert p.repo_stars == 0
    assert p.predicted_main_archetype is None
    assert p.predicted_second_tier_archetype is None


def test_maps_archetype_and_code_fields_when_present():
    """Once the corpus backfill populates them, the engine reads them onto the Paper."""
    src = {
        "corpusid": 9,
        "title": "Backfilled paper",
        "citationcount": 3,
        "publication_types": ["Conference"],
        "predicted_main_archetype": "The Innovator",
        "predicted_second_tier_archetype": "The Synthesizer",
        "has_public_code": True,
        "code_url": "https://github.com/x/y",
        "repo_stars": 42,
        "has_dataset": True,
    }
    engine = _make_engine(_FakeClient(hits=[src]), result_limit=10)
    p = engine.search("anything")[0]
    assert p.predicted_main_archetype == "The Innovator"
    assert p.predicted_second_tier_archetype == "The Synthesizer"
    assert p.has_public_code is True
    assert p.code_url == "https://github.com/x/y"
    assert p.repo_stars == 42
    assert p.has_dataset is True


def test_build_filters_fields_of_study_terms_clause():
    """A field-of-study selection compiles to a `terms` filter (OR over the values)."""
    from app.models.paper import ScholarFilters

    clauses = OpenSearchEngine._build_filters(
        ScholarFilters(fields_of_study=["Computer Science", "Medicine"])
    )
    assert {"terms": {"fields_of_study": ["Computer Science", "Medicine"]}} in clauses


def test_build_filters_omits_empty_fields_of_study():
    """No field-of-study constraint when the list is empty or None."""
    from app.models.paper import ScholarFilters

    for filters in (ScholarFilters(), ScholarFilters(fields_of_study=[])):
        clauses = OpenSearchEngine._build_filters(filters)
        assert all("fields_of_study" not in c.get("terms", {}) for c in clauses)


def test_build_filters_miscellaneous_only_is_must_not_exists():
    """Selecting only 'Miscellaneous' matches papers with NO field of study."""
    from app.models.paper import ScholarFilters

    clauses = OpenSearchEngine._build_filters(
        ScholarFilters(fields_of_study=["Miscellaneous"])
    )
    assert {"bool": {"must_not": {"exists": {"field": "fields_of_study"}}}} in clauses
    # No bare `terms` clause when only the synthetic bucket is selected.
    assert all("fields_of_study" not in c.get("terms", {}) for c in clauses)


def test_build_filters_fields_plus_miscellaneous_is_should():
    """Real fields + 'Miscellaneous' → OR of the terms clause and the missing clause."""
    from app.models.paper import ScholarFilters

    clauses = OpenSearchEngine._build_filters(
        ScholarFilters(fields_of_study=["Physics", "Miscellaneous"])
    )
    assert len(clauses) == 1
    should = clauses[0]["bool"]["should"]
    assert {"terms": {"fields_of_study": ["Physics"]}} in should
    assert {"bool": {"must_not": {"exists": {"field": "fields_of_study"}}}} in should
    assert clauses[0]["bool"]["minimum_should_match"] == 1


def test_field_facets_parses_terms_and_missing_aggs():
    """field_facets returns per-field counts, the Miscellaneous (missing) count, and total."""
    class _AggClient(_FakeClient):
        def search(self, index=None, body=None):
            self.last_index = index
            self.last_body = body
            return {
                "hits": {"total": {"value": 30, "relation": "eq"}},
                "aggregations": {
                    "fields": {"buckets": [
                        {"key": "Computer Science", "doc_count": 18},
                        {"key": "Physics", "doc_count": 7},
                    ]},
                    "miscellaneous": {"doc_count": 5},
                    "year_min": {"value": 1998.0},
                    "year_max": {"value": 2025.0},
                },
            }

    engine = _make_engine(_AggClient())
    result = engine.field_facets("LLM")
    assert result == {
        "fields": {"Computer Science": 18, "Physics": 7},
        "miscellaneous": 5,
        "total": 30,
        "year_min": 1998,
        "year_max": 2025,
    }
    # size:0 (aggregation-only) request with all aggs present.
    body = engine._client.last_body
    assert body["size"] == 0
    assert "fields" in body["aggs"] and "miscellaneous" in body["aggs"]
    assert "year_min" in body["aggs"] and "year_max" in body["aggs"]


def test_field_facets_year_bounds_none_when_no_year():
    """min/max aggs return value:None when no match carries a year -> year_min/max None."""
    class _AggClient(_FakeClient):
        def search(self, index=None, body=None):
            return {
                "hits": {"total": {"value": 4, "relation": "eq"}},
                "aggregations": {
                    "fields": {"buckets": []},
                    "miscellaneous": {"doc_count": 4},
                    "year_min": {"value": None},
                    "year_max": {"value": None},
                },
            }

    engine = _make_engine(_AggClient())
    result = engine.field_facets("LLM")
    assert result["year_min"] is None
    assert result["year_max"] is None


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


class _CorpusFakeClient:
    """Returns one hit per requested corpusid that exists in ``present``.

    Thread-safe enough for the parallel-hydration fan-out: it only reads ``present``
    and records call count under a lock.
    """

    def __init__(self, present, raises_on_chunk=None):
        import threading

        self._present = set(present)
        self._raises_on_chunk = raises_on_chunk  # raise on the Nth (1-based) chunk
        self.calls = 0
        self._lock = threading.Lock()

    def search(self, index=None, body=None):
        with self._lock:
            self.calls += 1
            n = self.calls
        if self._raises_on_chunk is not None and n == self._raises_on_chunk:
            raise RuntimeError("chunk boom")
        ids = body["query"]["terms"]["corpusid"]
        hits = [{"_source": {"corpusid": c}} for c in ids if c in self._present]
        return {"hits": {"hits": hits}}


def test_fetch_nodes_single_chunk_no_pool():
    engine = _make_engine(_CorpusFakeClient(present={1, 2, 3}))
    out = engine.fetch_nodes_by_corpusid([1, 2, 3, 99])  # 99 absent -> omitted
    assert set(out.keys()) == {1, 2, 3}
    assert engine._client.calls == 1  # one chunk, no fan-out


def test_fetch_nodes_multi_chunk_parallel_returns_all():
    ids = list(range(2500))  # 3 chunks of 1000/1000/500
    engine = _make_engine(_CorpusFakeClient(present=set(ids)))
    out = engine.fetch_nodes_by_corpusid(ids)
    assert set(out.keys()) == set(ids)
    assert engine._client.calls == 3  # fanned out across chunks


def test_fetch_nodes_multi_chunk_error_wrapped():
    ids = list(range(2500))
    engine = _make_engine(_CorpusFakeClient(present=set(ids), raises_on_chunk=2))
    with pytest.raises(OpenSearchSearchError):
        engine.fetch_nodes_by_corpusid(ids)


def test_fetch_nodes_empty_returns_empty():
    engine = _make_engine(_CorpusFakeClient(present=set()))
    assert engine.fetch_nodes_by_corpusid([]) == {}


def test_resolve_corpusids_doi_is_case_insensitive():
    """A lowercased DOI seed must resolve against a mixed-case stored DOI.

    Regression for the ok-graph "No papers found" bug: S2 stores DOIs in
    original (often upper) case, so the old case-sensitive `terms` match on a
    lowercased seed missed ~70% of papers and the graph came back empty.
    """
    client = _FakeClient(
        hits=[{"corpusid": 42, "doi": "10.2139/SSRN.361660", "arxiv_id": None}]
    )
    engine = _make_engine(client)

    # Seed arrives lowercased (as the frontend / old code would send it).
    assert engine.resolve_corpusids(["10.2139/ssrn.361660"]) == {
        "10.2139/ssrn.361660": 42
    }
    # And the original mixed-case seed resolves to the same corpusid.
    assert engine.resolve_corpusids(["10.2139/SSRN.361660"]) == {
        "10.2139/SSRN.361660": 42
    }

    # The emitted query must be case-insensitive `term` clauses, never a
    # case-sensitive `terms` clause.
    should = client.last_body["query"]["bool"]["should"]
    assert any(
        c.get("term", {}).get("doi", {}).get("case_insensitive") is True
        for c in should
    )
    assert all("terms" not in c for c in should)


def test_resolve_corpusids_bare_integer_is_direct():
    """A numeric seed is taken as a corpusid directly — no lookup query."""
    client = _FakeClient(hits=[])
    engine = _make_engine(client)
    assert engine.resolve_corpusids(["12345"]) == {"12345": 12345}
    # No identifier/title query was issued for a bare corpusid.
    assert client.last_body is None


def test_resolve_corpusids_unknown_identifier_dropped():
    """An identifier with no matching paper is silently omitted."""
    engine = _make_engine(_FakeClient(hits=[]))
    assert engine.resolve_corpusids(["10.0000/does.not.exist"]) == {}


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


def test_result_limit_override_caps_an_unlimited_engine(monkeypatch):
    """A per-call result_limit overrides an engine configured for unlimited, stopping early.

    Uses a cap above the 10k window so it exercises the scroll-and-stop path.
    """
    def fake_scan(client, **kwargs):
        for i in range(50_000):
            yield {"_source": {"corpusid": i, "title": "x"}}

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    engine = _make_engine(_FakeClient(), result_limit=None)  # engine = unlimited
    papers = list(engine.iter_search("neural", result_limit=12_000))
    assert len(papers) == 12_000


def test_result_limit_override_uses_fast_path_when_small():
    """A small override routes through the single-request BM25 path with that `size`."""
    client = _FakeClient(hits=[{"corpusid": 1, "title": "a"}, {"corpusid": 2, "title": "b"}])
    engine = _make_engine(client, result_limit=None)  # engine = unlimited
    papers = list(engine.iter_search("neural", result_limit=25))
    assert len(papers) == 2
    assert client.last_body["size"] == 25


def test_result_limit_override_none_means_unlimited(monkeypatch):
    """Passing None explicitly overrides a finite engine cap with unlimited streaming."""
    def fake_scan(client, **kwargs):
        for i in range(5):
            yield {"_source": {"corpusid": i, "title": "x"}}

    monkeypatch.setattr("opensearchpy.helpers.scan", fake_scan, raising=False)
    engine = _make_engine(_FakeClient(), result_limit=50)  # finite engine cap
    papers = list(engine.iter_search("neural", result_limit=None))
    assert len(papers) == 5  # streamed all via scan, not capped at 50


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


# ── search_page: paginated, filtered, total-bearing ──────────────────────────

class _Filters:
    """Lightweight stand-in for ScholarFilters (search_page reads attributes)."""
    def __init__(self, **kw):
        defaults = dict(
            year_min=None, year_max=None, citation_min=None, citation_max=None,
            open_access_only=False, peer_reviewed_only=False, code_only=False,
            archetypes=None,
        )
        defaults.update(kw)
        self.__dict__.update(defaults)


def _bool_query(body: dict) -> dict:
    """The ``bool`` query out of a search body, unwrapping the ``relevancy`` function_score.

    The ``relevancy`` sort ranks by the ok-score via a ``function_score`` wrapper, so the
    bool (match + filter clauses) lives one level down; other sorts use the bool directly.
    """
    query = body["query"]
    if "function_score" in query:
        return query["function_score"]["query"]["bool"]
    return query["bool"]


def test_search_page_returns_papers_and_total():
    client = _FakeClient(hits=[{"corpusid": 1, "title": "a"}, {"corpusid": 2, "title": "b"}],
                         total=4242)
    engine = _make_engine(client)
    papers, total = engine.search_page("neural", offset=0, size=2)
    assert [p.semantic_scholar_id for p in papers] == ["1", "2"]
    assert total == 4242
    body = client.last_body
    assert body["from"] == 0 and body["size"] == 2
    assert body["track_total_hits"] is True


def test_search_page_relevancy_ranks_by_okscore_function_score_with_tiebreak():
    """relevancy ranks the WHOLE match set by the ok-score via a native function_score
    (log10(1+citations) + peer bonus), sorted by _score — so paging stays globally ordered
    without the slow per-doc Painless script the alpha dropped."""
    client = _FakeClient(hits=[], total=0)
    engine = _make_engine(client)
    engine.search_page("neural", offset=0, size=10, sort="relevancy")
    body = client.last_body
    fs = body["query"]["function_score"]
    assert "bool" in fs["query"]
    assert fs["score_mode"] == "sum" and fs["boost_mode"] == "replace"
    funcs = fs["functions"]
    # log10(1+citationcount) via the base-10 log1p modifier.
    assert {"field_value_factor": {
        "field": "citationcount", "modifier": "log1p", "missing": 0}} in funcs
    # +1 weight for peer-reviewed papers (JournalArticle / Conference).
    peer = next(f for f in funcs if "filter" in f)
    assert peer["weight"] == 1.0
    assert peer["filter"] == {
        "terms": {"publication_types": ["JournalArticle", "Conference"]}}
    # Sorted by the computed score, with corpusid as a stable-paging tiebreaker.
    sort = body["sort"]
    assert sort[0] == {"_score": {"order": "desc"}}
    assert sort[-1] == {"corpusid": {"order": "asc"}}


def test_search_page_non_relevancy_uses_plain_field_sort():
    """Non-relevancy sorts keep a plain bool query + field sort (no function_score wrapper)."""
    client = _FakeClient(hits=[], total=0)
    engine = _make_engine(client)
    engine.search_page("neural", offset=0, size=10, sort="citations_desc")
    body = client.last_body
    assert "function_score" not in body["query"]
    assert body["query"]["bool"]["must"]
    assert body["sort"][0]["citationcount"]["order"] == "desc"
    assert body["sort"][-1] == {"corpusid": {"order": "asc"}}


def test_search_page_title_sort_uses_keyword_subfield():
    client = _FakeClient(hits=[], total=0)
    engine = _make_engine(client)
    engine.search_page("neural", offset=20, size=10, sort="title_asc")
    sort = client.last_body["sort"]
    assert sort[0] == {"title.kw": {"order": "asc"}}
    assert client.last_body["from"] == 20


def test_search_page_builds_filter_clauses():
    client = _FakeClient(hits=[], total=0)
    engine = _make_engine(client)
    filters = _Filters(
        year_min=2018, year_max=2024, citation_min=10,
        open_access_only=True, peer_reviewed_only=True, code_only=True,
        archetypes=["The Innovator", "The Analyst"],
    )
    engine.search_page("neural", offset=0, size=10, filters=filters)
    filt = _bool_query(client.last_body)["filter"]
    assert {"range": {"year": {"gte": 2018, "lte": 2024}}} in filt
    assert {"range": {"citationcount": {"gte": 10}}} in filt
    assert {"term": {"is_open_access": True}} in filt
    assert {"terms": {"publication_types": ["JournalArticle", "Conference"]}} in filt
    assert {"term": {"has_public_code": True}} in filt
    archetype_clause = next(c for c in filt if "bool" in c)
    assert archetype_clause["bool"]["minimum_should_match"] == 1
    assert {"terms": {"predicted_main_archetype": ["The Innovator", "The Analyst"]}} \
        in archetype_clause["bool"]["should"]


def test_search_page_no_filters_omits_filter_key():
    client = _FakeClient(hits=[], total=0)
    engine = _make_engine(client)
    engine.search_page("neural", offset=0, size=10, filters=_Filters())
    assert "filter" not in _bool_query(client.last_body)


def test_search_page_wraps_errors():
    engine = _make_engine(_FakeClient(raises=RuntimeError("boom"), total=0))
    with pytest.raises(OpenSearchSearchError):
        engine.search_page("neural", offset=0, size=10)


def test_ranked_corpusids_relevancy_ranks_by_okscore_function_score():
    """The archetype path ranks ids by the same global ok-score (function_score), so the
    archetype-filtered page is ordered consistently with the unfiltered page."""
    client = _FakeClient(
        hits=[{"corpusid": 7}, {"corpusid": 9}], total=2,
    )
    engine = _make_engine(client)
    ids, total = engine.ranked_corpusids("neural", sort="relevancy", limit=50)
    assert ids == [7, 9] and total == 2
    body = client.last_body
    assert "function_score" in body["query"]
    assert body["sort"][0] == {"_score": {"order": "desc"}}
    assert body["_source"] == ["corpusid"]


# ── seed resolution & node hydration (citation graph support) ─────────────────

class _RoutingClient:
    """Routes search() by query shape: identifier terms / title match / corpusid terms."""

    def __init__(self, identifier_hits=None, title_hits=None, node_hits=None):
        self._identifier_hits = identifier_hits or []
        self._title_hits = title_hits or []
        self._node_hits = node_hits or []
        self.search_calls = 0

    def search(self, index=None, body=None):
        self.search_calls += 1
        q = body["query"]
        if "bool" in q:  # identifier lookup (should: terms on doi/arxiv_id)
            hits = self._identifier_hits
        elif "match" in q:  # title lookup
            hits = self._title_hits
        elif "terms" in q and "corpusid" in q["terms"]:  # node hydration
            ids = set(q["terms"]["corpusid"])
            hits = [h for h in self._node_hits if h.get("corpusid") in ids]
        else:  # pragma: no cover
            hits = []
        return {"hits": {"hits": [{"_source": s} for s in hits]}}


def test_resolve_corpusids_integer_passthrough():
    engine = _make_engine(_RoutingClient())
    assert engine.resolve_corpusids(["12345"]) == {"12345": 12345}


def test_resolve_corpusids_doi_and_title():
    client = _RoutingClient(
        identifier_hits=[{"corpusid": 100, "doi": "10.5/xyz", "arxiv_id": None}],
        title_hits=[{"corpusid": 200}],
    )
    engine = _make_engine(client)
    out = engine.resolve_corpusids(["10.5/XYZ", "Attention Is All You Need", "nope-id"])
    # DOI resolves case-insensitively; title resolves via match; unknown id is dropped.
    assert out == {"10.5/XYZ": 100, "Attention Is All You Need": 200}


def test_fetch_nodes_by_corpusid_maps_and_chunks():
    node_hits = [
        {"corpusid": i, "title": f"P{i}", "authors": [], "publication_types": []}
        for i in range(1500)
    ]
    client = _RoutingClient(node_hits=node_hits)
    engine = _make_engine(client)
    out = engine.fetch_nodes_by_corpusid(list(range(1500)))
    assert len(out) == 1500
    assert out[7].title == "P7"
    assert out[7].semantic_scholar_id == "7"
    assert client.search_calls == 2  # chunked at 1000


def test_fetch_nodes_omits_missing():
    client = _RoutingClient(node_hits=[{"corpusid": 1, "title": "only", "authors": [], "publication_types": []}])
    engine = _make_engine(client)
    out = engine.fetch_nodes_by_corpusid([1, 2, 3])
    assert set(out) == {1}
