"""Live integration tests for arXiv adapter."""
from __future__ import annotations

import pytest
from app.services.retrieval.adapters.arxiv import ArxivAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return ArxivAdapter()


@pytest.mark.asyncio
async def test_simple_query_returns_results(adapter):
    papers = await adapter.search('"large language model"')
    await adapter.close()
    assert len(papers) > 0


@pytest.mark.asyncio
async def test_boolean_query_returns_results(adapter):
    raw = '("large language model" OR LLM) AND compression'
    papers = await adapter.search(raw)
    await adapter.close()
    assert len(papers) > 0, f"Expected results but got 0. Query sent: {raw}"
