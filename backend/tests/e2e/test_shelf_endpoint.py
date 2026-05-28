"""End-to-end tests for the /api/shelf endpoints."""
from __future__ import annotations

import uuid

import pytest
import httpx
from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


@pytest.mark.asyncio
async def test_duplicate_query_rejected():
    """The same query text cannot be saved to the shelf twice."""
    query = f"unique query {uuid.uuid4()}"
    async with _client() as client:
        first = await client.post("/api/shelf", json={"query_text": query})
        assert first.status_code == 201
        item_id = first.json()["id"]

        # Exact duplicate -> 409
        dup = await client.post("/api/shelf", json={"query_text": query})
        assert dup.status_code == 409

        # Whitespace-padded duplicate is also rejected (query_text is trimmed)
        padded = await client.post("/api/shelf", json={"query_text": f"  {query}  "})
        assert padded.status_code == 409

        await client.delete(f"/api/shelf/{item_id}")
