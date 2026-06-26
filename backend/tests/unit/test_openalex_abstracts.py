"""Unit tests for the OpenAlex abstract backfill adapter (subtask 03).

Covers the pure reconstruction/dedup helpers and the batched fetcher against a mocked
httpx client (no network): filter/URL construction, batching at the size cap, mailto
presence, abstract reconstruction, skipping works with no inverted index, and 429 backoff.
"""
from __future__ import annotations

import httpx
import pytest

from app.services.retrieval.openalex_abstracts import (
    OpenAlexAbstractFetcher,
    _Candidate,
    normalize_doi,
    normalize_pmid,
    pick_longest_per_corpusid,
    reconstruct_abstract,
)


# --- reconstruct_abstract --------------------------------------------------

def test_reconstruct_basic_in_order():
    inv = {"Deep": [0], "learning": [1], "is": [2], "great": [3]}
    assert reconstruct_abstract(inv) == "Deep learning is great"


def test_reconstruct_out_of_order_and_gaps():
    # world at 0, Hello at 1 -> read by position
    assert reconstruct_abstract({"Hello": [1], "world": [0]}) == "world Hello"
    # repeated token at multiple positions
    assert reconstruct_abstract({"a": [0, 2], "b": [1]}) == "a b a"


def test_reconstruct_single_token():
    assert reconstruct_abstract({"solo": [0]}) == "solo"


def test_reconstruct_empty_and_none():
    assert reconstruct_abstract(None) is None
    assert reconstruct_abstract({}) is None
    assert reconstruct_abstract({"x": []}) is None


# --- normalizers -----------------------------------------------------------

def test_normalize_doi_strips_prefix_and_lowercases():
    assert normalize_doi("https://doi.org/10.1/AbC") == "10.1/abc"
    assert normalize_doi("10.2/XYZ") == "10.2/xyz"
    assert normalize_doi(None) is None


def test_normalize_pmid_strips_url():
    assert normalize_pmid("https://pubmed.ncbi.nlm.nih.gov/555") == "555"
    assert normalize_pmid("555") == "555"


# --- pick_longest_per_corpusid ---------------------------------------------

def test_dedup_longest_per_corpusid():
    cands = [
        _Candidate(corpusid=1, abstract="short", source_id="Wa", match_key="doi"),
        _Candidate(corpusid=1, abstract="a much longer abstract", source_id="Wb", match_key="pmid"),
        _Candidate(corpusid=2, abstract="only one", source_id="Wc", match_key="mag"),
    ]
    best = pick_longest_per_corpusid(cands)
    assert set(best) == {1, 2}
    assert best[1].source_id == "Wb"  # longest wins
    assert best[1].match_key == "pmid"
    assert best[2].abstract == "only one"


# --- fetcher (mocked transport) --------------------------------------------

def _mock_fetcher(handler, **kw) -> OpenAlexAbstractFetcher:
    """Build a fetcher whose httpx client is backed by a MockTransport handler."""
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    return OpenAlexAbstractFetcher(client=client, mailto="test@example.com",
                                   sleep=_noop_sleep, **kw)


async def _noop_sleep(_seconds):  # injected: no real waiting
    return None


@pytest.mark.asyncio
async def test_fetch_by_dois_builds_filter_and_reconstructs():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"results": [
            {"id": "https://openalex.org/W1",
             "ids": {"doi": "https://doi.org/10.1/abc"},
             "abstract_inverted_index": {"hello": [0], "world": [1]}},
            # a work with no inverted index -> must be skipped
            {"id": "https://openalex.org/W2", "ids": {"doi": "https://doi.org/10.2/xyz"}},
        ]})

    fetcher = _mock_fetcher(handler)
    out = await fetcher.fetch_by_dois(["10.1/abc", "https://doi.org/10.2/XYZ"])
    await fetcher.aclose()

    assert set(out) == {"10.1/abc"}  # W2 skipped (no abstract)
    assert out["10.1/abc"].abstract == "hello world"
    assert out["10.1/abc"].match_key == "doi"
    # one request, correct filter + mailto + select
    assert len(seen) == 1
    url = seen[0].url
    assert url.path == "/works"
    assert url.params["filter"] == "doi:10.1/abc|10.2/xyz"
    assert url.params["mailto"] == "test@example.com"
    assert url.params["select"] == "id,ids,abstract_inverted_index"


@pytest.mark.asyncio
async def test_fetch_batches_at_size_cap():
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        flt = request.url.params["filter"]
        n = len(flt.split(":", 1)[1].split("|"))
        calls.append(n)
        return httpx.Response(200, json={"results": []})

    fetcher = _mock_fetcher(handler, batch_size=2)
    await fetcher.fetch_by_mags(["1", "2", "3", "4", "5"])
    await fetcher.aclose()

    assert calls == [2, 2, 1]  # 5 ids chunked into 2,2,1


@pytest.mark.asyncio
async def test_retry_on_429_then_success():
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(429, json={})
        return httpx.Response(200, json={"results": [
            {"id": "https://openalex.org/W9", "ids": {"pmid": "777"},
             "abstract_inverted_index": {"ok": [0]}},
        ]})

    fetcher = _mock_fetcher(handler)
    out = await fetcher.fetch_by_pmids(["777"])
    await fetcher.aclose()

    assert attempts["n"] == 2  # one 429, then success
    assert out["777"].abstract == "ok"


@pytest.mark.asyncio
async def test_non_retryable_4xx_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={})

    fetcher = _mock_fetcher(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await fetcher.fetch_by_dois(["10.1/bad"])
    await fetcher.aclose()
