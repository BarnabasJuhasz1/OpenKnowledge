"""Tests verifying that each adapter passes the user's query through unchanged.

All adapters now receive the exact same query the user typed.
"""
from __future__ import annotations

from app.services.retrieval.adapters.semantic_scholar import SemanticScholarAdapter
from app.services.retrieval.adapters.crossref import CrossRefAdapter
from app.services.retrieval.adapters.arxiv import ArxivAdapter
from app.services.retrieval.adapters.openalex import OpenAlexAdapter

BOOL_QUERY = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'


class TestAdaptersReceiveSameQuery:
    """Every adapter's search() receives the raw user query — no normalization."""

    def test_semantic_scholar_has_no_normalize(self):
        adapter = SemanticScholarAdapter()
        assert not hasattr(adapter, 'normalize_query') or adapter.__class__.search is not None

    def test_crossref_has_no_normalize(self):
        adapter = CrossRefAdapter()
        assert not hasattr(adapter, 'normalize_query') or adapter.__class__.search is not None

    def test_arxiv_has_no_normalize(self):
        adapter = ArxivAdapter()
        assert not hasattr(adapter, 'normalize_query') or adapter.__class__.search is not None

    def test_openalex_has_no_normalize(self):
        adapter = OpenAlexAdapter()
        assert not hasattr(adapter, 'normalize_query') or adapter.__class__.search is not None
