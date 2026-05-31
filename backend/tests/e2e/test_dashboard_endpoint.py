"""End-to-end tests for the /api/dashboard/stats endpoint."""
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
async def test_stats_shape():
    async with _client() as client:
        resp = await client.get("/api/dashboard/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert {"totals", "projects", "recent_activity"} <= body.keys()
        totals = body["totals"]
        for key in (
            "projects",
            "library_papers",
            "saved_searches",
            "retrieved_papers",
            "searches_run",
            "papers_added_this_week",
        ):
            assert isinstance(totals[key], int)
        assert isinstance(body["projects"], list)
        assert isinstance(body["recent_activity"], list)


@pytest.mark.asyncio
async def test_stats_aggregate_across_project():
    name = f"Dash {uuid.uuid4()}"
    async with _client() as client:
        # Baseline totals before seeding.
        before = (await client.get("/api/dashboard/stats")).json()["totals"]

        proj = await client.post("/api/projects", json={"name": name, "color": "#10b981"})
        assert proj.status_code == 201
        pid = proj.json()["id"]
        params = {"project_id": pid}

        # Two library papers + one saved search, all scoped to the project.
        for i in range(2):
            add = await client.post(
                "/api/bookshelf",
                params=params,
                json={
                    "paper_identifier": f"{uuid.uuid4()}",
                    "title": f"Paper {i}",
                    "authors": ["A. Author"],
                    "year": 2024,
                },
            )
            assert add.status_code == 201
        search = await client.post(
            "/api/shelf", params=params, json={"query_text": f"q-{uuid.uuid4()}"}
        )
        assert search.status_code == 201

        body = (await client.get("/api/dashboard/stats")).json()

        # The project shows the right per-project counts.
        mine = next(p for p in body["projects"] if p["id"] == pid)
        assert mine["library_papers"] == 2
        assert mine["saved_searches"] == 1
        assert mine["name"] == name
        assert mine["color"] == "#10b981"

        # Global totals grew by at least what we added.
        assert body["totals"]["library_papers"] >= before["library_papers"] + 2
        assert body["totals"]["saved_searches"] >= before["saved_searches"] + 1
        assert body["totals"]["projects"] >= before["projects"] + 1

        # The activity feed references this project.
        assert any(a["project_id"] == pid for a in body["recent_activity"])

        # Cleanup.
        assert (await client.delete(f"/api/projects/{pid}")).status_code == 204
