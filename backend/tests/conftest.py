"""Shared test fixtures."""
from __future__ import annotations

import pytest

# The problematic query that triggers the zero-results bug
PROBLEMATIC_QUERY = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'

# A simpler query that should always return results
SIMPLE_QUERY = '"large language model"'


@pytest.fixture
def problematic_query() -> str:
    return PROBLEMATIC_QUERY


@pytest.fixture
def simple_query() -> str:
    return SIMPLE_QUERY
