"""End-to-end tests for the /api/projects endpoints."""
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
async def test_project_crud_flow():
    name = f"My Project {uuid.uuid4()}"
    async with _client() as client:
        # Create
        create = await client.post(
            "/api/projects",
            json={"name": name, "description": "Lit review", "color": "#6366f1"},
        )
        assert create.status_code == 201
        proj = create.json()
        pid = proj["id"]
        assert proj["name"] == name
        assert proj["description"] == "Lit review"
        assert proj["color"] == "#6366f1"

        # List contains it
        listing = await client.get("/api/projects")
        assert listing.status_code == 200
        assert any(p["id"] == pid for p in listing.json())

        # Get
        got = await client.get(f"/api/projects/{pid}")
        assert got.status_code == 200
        assert got.json()["name"] == name

        # Update
        upd = await client.put(f"/api/projects/{pid}", json={"name": "Renamed"})
        assert upd.status_code == 200
        assert upd.json()["name"] == "Renamed"

        # Delete
        deleted = await client.delete(f"/api/projects/{pid}")
        assert deleted.status_code == 204

        # Gone
        gone = await client.get(f"/api/projects/{pid}")
        assert gone.status_code == 404


@pytest.mark.asyncio
async def test_empty_name_rejected():
    async with _client() as client:
        resp = await client.post("/api/projects", json={"name": "   "})
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_delete_cascades_scoped_data():
    """Deleting a project removes its bookshelf items."""
    pid_str = f"casc-{uuid.uuid4()}"
    async with _client() as client:
        proj = await client.post("/api/projects", json={"name": "Cascade"})
        project_id = proj.json()["id"]
        p = {"project_id": project_id}

        add = await client.post(
            "/api/bookshelf",
            params=p,
            json={"paper_identifier": pid_str, "title": "X", "authors": [], "year": None},
        )
        assert add.status_code == 201

        # Delete the project
        assert (await client.delete(f"/api/projects/{project_id}")).status_code == 204

        # Bookshelf endpoint for that project now 404s (project gone)
        listing = await client.get("/api/bookshelf", params=p)
        assert listing.status_code == 404
