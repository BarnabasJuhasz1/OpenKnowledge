"""Live integration tests for DBLP adapter."""
from __future__ import annotations

import pytest
from app.services.retrieval.adapters.dblp import DblpAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return DblpAdapter()


@pytest.mark.asyncio
async def test_simple_query_returns_results(adapter):
    papers = await adapter.search("large language model")
    await adapter.close()
    assert len(papers) > 0


@pytest.mark.asyncio
async def test_boolean_query_returns_results(adapter):
    query = '("large language model" OR LLM) AND compression'
    papers = await adapter.search(query)
    await adapter.close()
    assert len(papers) > 0
