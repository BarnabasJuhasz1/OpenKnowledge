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


async def _make_project(client: httpx.AsyncClient) -> int:
    resp = await client.post("/api/projects", json={"name": f"Proj {uuid.uuid4()}"})
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_duplicate_query_rejected():
    """The same query text cannot be saved to the shelf twice in one project."""
    query = f"unique query {uuid.uuid4()}"
    async with _client() as client:
        pid = await _make_project(client)
        p = {"project_id": pid}
        first = await client.post("/api/shelf", params=p, json={"query_text": query})
        assert first.status_code == 201
        item_id = first.json()["id"]

        # Exact duplicate -> 409
        dup = await client.post("/api/shelf", params=p, json={"query_text": query})
        assert dup.status_code == 409

        # Whitespace-padded duplicate is also rejected (query_text is trimmed)
        padded = await client.post(
            "/api/shelf", params=p, json={"query_text": f"  {query}  "}
        )
        assert padded.status_code == 409

        await client.delete(f"/api/shelf/{item_id}", params=p)


@pytest.mark.asyncio
async def test_shelf_requires_valid_project():
    """Scoped endpoints reject missing or unknown projects."""
    async with _client() as client:
        # No project_id at all -> 422 (required query param)
        missing = await client.get("/api/shelf")
        assert missing.status_code == 422

        # Unknown project id -> 404
        unknown = await client.get("/api/shelf", params={"project_id": 999999})
        assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_shelf_isolated_between_projects():
    """A query saved in one project is not visible from another."""
    query = f"isolated {uuid.uuid4()}"
    async with _client() as client:
        a = await _make_project(client)
        b = await _make_project(client)
        created = await client.post(
            "/api/shelf", params={"project_id": a}, json={"query_text": query}
        )
        assert created.status_code == 201

        in_a = await client.get("/api/shelf", params={"project_id": a})
        assert any(i["query_text"] == query for i in in_a.json())

        in_b = await client.get("/api/shelf", params={"project_id": b})
        assert all(i["query_text"] != query for i in in_b.json())

        # Same text is allowed again in a different project
        created_b = await client.post(
            "/api/shelf", params={"project_id": b}, json={"query_text": query}
        )
        assert created_b.status_code == 201
