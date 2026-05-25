"""Live integration tests for PubMed adapter."""
from __future__ import annotations

import os
import pytest
from app.services.retrieval.adapters.pubmed import PubMedAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return PubMedAdapter(api_key=os.getenv("PUBMED_API_KEY"))


@pytest.mark.asyncio
async def test_simple_query_returns_results(adapter):
    papers = await adapter.search('"large language model"')
    await adapter.close()
    assert len(papers) > 0


@pytest.mark.asyncio
async def test_boolean_query_returns_results(adapter):
    query = '("large language model" OR LLM) AND compression'
    papers = await adapter.search(query)
    await adapter.close()
    assert len(papers) > 0
