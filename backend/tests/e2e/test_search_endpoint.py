"""End-to-end tests for the /api/retrieval/search/stream endpoint."""
from __future__ import annotations

import json
import pytest
import httpx
from app.main import app

pytestmark = pytest.mark.live

PROBLEMATIC_QUERY = '("large language model" OR LLM) AND compression AND RAG OR "Retrieval Augmented Generation"'


@pytest.mark.asyncio
async def test_stream_endpoint_returns_papers():
    """POST to search/stream with the problematic query should return papers from at least one source."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # Create a project first to satisfy require_project dependency
        proj_resp = await client.post("/api/projects", json={"name": "Test Search Project"})
        assert proj_resp.status_code == 201
        pid = proj_resp.json()["id"]

        response = await client.post(
            "/api/retrieval/search/stream",
            params={"project_id": pid},
            json={
                "keywords": ["large language model", "compression", "RAG"],
                "raw_query": PROBLEMATIC_QUERY,
            },
            timeout=120.0,
        )

    assert response.status_code == 200

    # Parse SSE events
    events = []
    for line in response.text.split("\n"):
        if line.startswith("data: "):
            payload = json.loads(line[6:])
            events.append(payload)

    # At least one source should have returned papers
    papers_found = any(
        e.get("papers") and len(e["papers"]) > 0
        for e in events
        if "papers" in e
    )
    assert papers_found, f"No papers returned from any source. Events: {[e.get('source') for e in events]}"


@pytest.mark.asyncio
async def test_stream_endpoint_semantic_scholar_not_failed():
    """Semantic Scholar should not fail with the query."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # Create a project first to satisfy require_project dependency
        proj_resp = await client.post("/api/projects", json={"name": "Test SS Project"})
        assert proj_resp.status_code == 201
        pid = proj_resp.json()["id"]

        response = await client.post(
            "/api/retrieval/search/stream",
            params={"project_id": pid},
            json={
                "keywords": ["large language model", "compression", "RAG"],
                "raw_query": PROBLEMATIC_QUERY,
                "databases": ["semantic_scholar"],
            },
            timeout=120.0,
        )

    assert response.status_code == 200

    for line in response.text.split("\n"):
        if line.startswith("data: "):
            payload = json.loads(line[6:])
            if payload.get("source") == "semantic_scholar":
                assert payload.get("failed") is not True, "Semantic Scholar adapter failed"
                assert len(payload.get("papers", [])) > 0, "Semantic Scholar returned 0 papers"
                break
