"""Live integration tests for CORE adapter."""
from __future__ import annotations

import os
import pytest
from app.services.retrieval.adapters.core import CoreAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    api_key = os.getenv("CORE_API_KEY")
    if not api_key:
        pytest.skip("CORE_API_KEY not set")
    return CoreAdapter(api_key=api_key)


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
