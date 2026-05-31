from __future__ import annotations
import pytest
from app.services.retrieval.demo import DemoDataStore

def test_demo_store_search_all_results():
    store = DemoDataStore.get()
    # Search for something very common in the demo papers, e.g. a simple word like "network" or similar
    # First ensure it loads and we can run search
    papers = store.search(["network"], limit=None)
    assert isinstance(papers, list)
    assert len(papers) > 0
    # Make sure papers have predicted_main_archetype and predicted_second_tier_archetype loaded correctly
    for p in papers:
        assert p.sources == ["demo"]
        # Ensure archetypes are either string or None
        assert p.predicted_main_archetype is None or isinstance(p.predicted_main_archetype, str)
        assert p.predicted_second_tier_archetype is None or isinstance(p.predicted_second_tier_archetype, str)

def test_demo_store_search_with_limit():
    store = DemoDataStore.get()
    # Limit to 5 results
    papers_limited = store.search(["network"], limit=5)
    papers_all = store.search(["network"], limit=None)
    
    assert len(papers_limited) <= 5
    if len(papers_all) > 5:
        assert len(papers_limited) == 5
        # Ensure it returns the 5 with highest citations
        assert [p.citation_count for p in papers_limited] == sorted([p.citation_count for p in papers_limited], reverse=True)
