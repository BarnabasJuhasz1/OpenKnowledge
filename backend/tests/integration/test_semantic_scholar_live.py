"""Live integration tests for Semantic Scholar adapter."""
from __future__ import annotations

import os
import pytest
from app.services.retrieval.adapters.semantic_scholar import SemanticScholarAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return SemanticScholarAdapter(api_key=os.getenv("SEMANTIC_SCHOLAR_API_KEY"))


@pytest.mark.asyncio
async def test_simple_query_returns_results(adapter):
    papers = await adapter.search('"large language model"')
    await adapter.close()
    assert len(papers) > 0


@pytest.mark.asyncio
async def test_boolean_query_returns_results(adapter):
    raw = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'
    papers = await adapter.search(raw)
    await adapter.close()
    assert len(papers) > 0, f"Expected results but got 0 for query: {raw}"
