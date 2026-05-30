"""Shared test fixtures."""
from __future__ import annotations

import os

# Isolate tests onto a dedicated DB. Must be set before app.db.database is
# imported (it builds the async engine from this env var at import time).
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_openknowledge.db"

import pytest
from sqlalchemy import create_engine

from app.db.database import Base
from app.db import orm_models  # noqa: F401 — registers models on Base.metadata


@pytest.fixture(scope="session", autouse=True)
def _setup_test_db():
    """Build a fresh schema for the test DB once per session.

    Uses a synchronous engine (same SQLite file) so schema creation never
    competes with the async engine's event loop.
    """
    sync_engine = create_engine("sqlite:///./test_openknowledge.db")
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    sync_engine.dispose()
    yield


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
