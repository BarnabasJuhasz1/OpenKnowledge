"""Unit tests for the archetype classification cache."""

from __future__ import annotations

import pytest

from app.models.paper import Paper
from app.services.archetype import cache as archetype_cache


@pytest.fixture(autouse=True)
def _clear():
    archetype_cache.clear()
    yield
    archetype_cache.clear()


def test_paper_cache_key_prefers_corpusid():
    p = Paper(title="t", abstract="some abstract", semantic_scholar_id="42")
    assert archetype_cache.paper_cache_key(p) == archetype_cache.corpusid_key("42")
    assert archetype_cache.corpusid_key(42) == "c:42"


def test_paper_cache_key_falls_back_to_abstract_hash():
    a = Paper(title="t", abstract="identical abstract")
    b = Paper(title="other", abstract="identical abstract")
    key = archetype_cache.paper_cache_key(a)
    assert key is not None and key.startswith("a:")
    # Same abstract -> same key (duplicate abstracts share a classification).
    assert key == archetype_cache.paper_cache_key(b)


def test_paper_cache_key_falls_back_to_title_hash():
    # Abstract-less papers are classified from their title, so a title-only paper (no
    # corpusid, no abstract) is keyed by a title hash rather than being uncacheable.
    a = Paper(title="identical title")
    b = Paper(title="identical title", abstract="   ")
    key = archetype_cache.paper_cache_key(a)
    assert key is not None and key.startswith("t:")
    assert key == archetype_cache.paper_cache_key(b)


def test_paper_cache_key_none_without_any_text():
    # No corpusid, no abstract, blank title -> nothing stable to key on.
    assert archetype_cache.paper_cache_key(Paper(title="   ")) is None


def test_get_put_roundtrip_and_none_is_a_hit():
    assert archetype_cache.get("c:1") is None
    archetype_cache.put("c:1", "The Innovator", "Algorithm/Architecture")
    assert archetype_cache.get("c:1") == ("The Innovator", "Algorithm/Architecture")

    # A genuinely-unarchetyped paper caches (None, None) and still reads back as a hit.
    archetype_cache.put("c:2", None, None)
    assert archetype_cache.get("c:2") == (None, None)


def test_put_ignores_empty_key():
    archetype_cache.put(None, "The Innovator", None)
    assert archetype_cache.get(None) is None


def test_eviction_bounds_size(monkeypatch):
    monkeypatch.setattr(archetype_cache, "_MAX_ENTRIES", 10)
    for i in range(13):
        archetype_cache.put(f"c:{i}", "The Innovator", None)
    # Oldest entries were evicted in a batch once the bound was hit.
    assert len(archetype_cache._CACHE) <= 10
    assert archetype_cache.get("c:0") is None      # evicted
    assert archetype_cache.get("c:12") is not None  # most recent survives
