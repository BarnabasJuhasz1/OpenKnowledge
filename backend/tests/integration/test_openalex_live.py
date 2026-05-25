"""Live integration tests for OpenAlex adapter."""
from __future__ import annotations

import os
import pytest
from app.services.retrieval.adapters.openalex import OpenAlexAdapter

pytestmark = pytest.mark.live


@pytest.fixture
def adapter():
    return OpenAlexAdapter(contact_email=os.getenv("CONTACT_EMAIL"))


@pytest.mark.asyncio
async def test_simple_query_returns_results(adapter):
    papers = await adapter.search('"large language model"')
    await adapter.close()
    assert len(papers) > 0


@pytest.mark.asyncio
async def test_boolean_query_returns_results(adapter):
    query = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'
    papers = await adapter.search(query)
    await adapter.close()
    assert len(papers) > 0
