"""Live integration tests for CrossRef adapter."""
from __future__ import annotations

import os
import pytest
from app.services.retrieval.adapters.crossref import CrossRefAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return CrossRefAdapter(contact_email=os.getenv("CONTACT_EMAIL"))


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
    assert len(papers) > 0, f"Expected results but got 0. Query sent: {raw}"
