"""End-to-end tests for the /api/bookshelf endpoints."""
from __future__ import annotations

import uuid

import pytest
import httpx
from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def _make_project(client: httpx.AsyncClient) -> dict:
    resp = await client.post("/api/projects", json={"name": f"Proj {uuid.uuid4()}"})
    assert resp.status_code == 201
    return {"project_id": resp.json()["id"]}


@pytest.mark.asyncio
async def test_bookshelf_crud_flow():
    """Add, list, update notes, and remove a bookshelf item."""
    pid = f"test-doi-{uuid.uuid4()}"
    async with _client() as client:
        p = await _make_project(client)
        # Add
        add_resp = await client.post(
            "/api/bookshelf",
            params=p,
            json={
                "paper_identifier": pid,
                "title": "A Test Paper on Graphs",
                "authors": ["Alice Smith", "Bob Jones"],
                "year": 2024,
            },
        )
        assert add_resp.status_code == 201
        item = add_resp.json()
        item_id = item["id"]
        assert item["title"] == "A Test Paper on Graphs"
        assert item["authors"] == ["Alice Smith", "Bob Jones"]
        assert item["year"] == 2024
        assert item["notes"] is None
        assert item["paper"] is None

        # Check
        check_resp = await client.get(f"/api/bookshelf/check/{pid}", params=p)
        assert check_resp.status_code == 200
        assert check_resp.json()["bookmarked"] is True

        # List
        list_resp = await client.get("/api/bookshelf", params=p)
        assert list_resp.status_code == 200
        assert any(i["id"] == item_id for i in list_resp.json())

        # Update notes
        upd_resp = await client.put(
            f"/api/bookshelf/{item_id}",
            params=p,
            json={"notes": "Key paper for the lit review."},
        )
        assert upd_resp.status_code == 200
        assert upd_resp.json()["notes"] == "Key paper for the lit review."

        # Duplicate add should 409
        dup_resp = await client.post(
            "/api/bookshelf",
            params=p,
            json={
                "paper_identifier": pid,
                "title": "Duplicate",
                "authors": [],
                "year": None,
            },
        )
        assert dup_resp.status_code == 409

        # Delete
        del_resp = await client.delete(f"/api/bookshelf/{item_id}", params=p)
        assert del_resp.status_code == 204

        # Check after delete
        check2 = await client.get(f"/api/bookshelf/check/{pid}", params=p)
        assert check2.json()["bookmarked"] is False


@pytest.mark.asyncio
async def test_paper_snapshot_round_trips():
    """The full paper snapshot sent on add is returned by list/check."""
    pid = f"test-snap-{uuid.uuid4()}"
    paper = {"title": "Snapshot Paper", "abstract": "An abstract.", "citation_count": 42}
    async with _client() as client:
        p = await _make_project(client)
        add_resp = await client.post(
            "/api/bookshelf",
            params=p,
            json={
                "paper_identifier": pid,
                "title": "Snapshot Paper",
                "authors": ["A"],
                "year": 2023,
                "paper": paper,
            },
        )
        assert add_resp.status_code == 201
        item = add_resp.json()
        assert item["paper"] == paper

        list_resp = await client.get("/api/bookshelf", params=p)
        stored = next(i for i in list_resp.json() if i["id"] == item["id"])
        assert stored["paper"]["citation_count"] == 42

        await client.delete(f"/api/bookshelf/{item['id']}", params=p)


@pytest.mark.asyncio
async def test_notes_preserved_across_readd():
    """Notes added to a paper survive removal and are restored on re-add."""
    pid = f"test-notes-{uuid.uuid4()}"
    async with _client() as client:
        p = await _make_project(client)
        # Add and annotate
        add_resp = await client.post(
            "/api/bookshelf",
            params=p,
            json={"paper_identifier": pid, "title": "Notable", "authors": [], "year": None},
        )
        item_id = add_resp.json()["id"]
        await client.put(
            f"/api/bookshelf/{item_id}", params=p, json={"notes": "Remember this."}
        )

        # Remove
        del_resp = await client.delete(f"/api/bookshelf/{item_id}", params=p)
        assert del_resp.status_code == 204

        # Re-add without notes — they should come back
        readd = await client.post(
            "/api/bookshelf",
            params=p,
            json={"paper_identifier": pid, "title": "Notable", "authors": [], "year": None},
        )
        assert readd.status_code == 201
        assert readd.json()["notes"] == "Remember this."

        await client.delete(f"/api/bookshelf/{readd.json()['id']}", params=p)


@pytest.mark.asyncio
async def test_bookshelf_isolated_between_projects():
    """The same paper can live in two projects independently."""
    pid = f"test-iso-{uuid.uuid4()}"
    async with _client() as client:
        a = await _make_project(client)
        b = await _make_project(client)
        body = {"paper_identifier": pid, "title": "Shared", "authors": [], "year": 2024}

        ra = await client.post("/api/bookshelf", params=a, json=body)
        assert ra.status_code == 201
        # Same identifier in another project is allowed (not a duplicate)
        rb = await client.post("/api/bookshelf", params=b, json=body)
        assert rb.status_code == 201

        # Each project lists only its own copy
        check_a = await client.get(f"/api/bookshelf/check/{pid}", params=a)
        assert check_a.json()["bookmarked"] is True

        # Removing from A leaves B intact
        await client.delete(f"/api/bookshelf/{ra.json()['id']}", params=a)
        still_b = await client.get(f"/api/bookshelf/check/{pid}", params=b)
        assert still_b.json()["bookmarked"] is True
        await client.delete(f"/api/bookshelf/{rb.json()['id']}", params=b)
