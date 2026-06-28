"""okgraph-snapshots-02: snapshot CRUD API.

Ownership is transitive through the project (project-ownership series): the path
project must be visible to the caller (owned if signed in, null bucket if a
guest) or every snapshot route 404s. Capped at 3 per project. Auth is simulated
by overriding `optional_current_user`, as in test_project_ownership.py.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager

import httpx
import pytest

from app.api.auth import optional_current_user
from app.db.database import AsyncSessionLocal
from app.db.orm_models import DBUser
from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def _make_user() -> DBUser:
    async with AsyncSessionLocal() as session:
        user = DBUser(provider="github", provider_account_id=str(uuid.uuid4()))
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


@contextmanager
def _as(user: DBUser | None):
    app.dependency_overrides[optional_current_user] = lambda: user
    try:
        yield
    finally:
        app.dependency_overrides.pop(optional_current_user, None)


async def _make_project(client: httpx.AsyncClient) -> int:
    resp = await client.post("/api/projects", json={"name": f"P {uuid.uuid4()}"})
    assert resp.status_code == 201
    return resp.json()["id"]


def _graph(seed: str = "n1") -> dict:
    return {
        "nodes": [{"paper_id": "n1"}, {"paper_id": "n2"}],
        "edges": [],
        "seedId": seed,
        "resolution": 1.0,
        "maxLevels": 10,
        "directionalSplit": False,
    }


def _summaries() -> list[dict]:
    # Top level (max level = 1) has two communities → cluster_count == 2.
    return [
        {"level": 1, "community": 0, "title": "A", "summary": "s", "bullets": ["x"]},
        {"level": 1, "community": 1, "title": "B", "summary": "s", "bullets": []},
        {"level": 0, "community": 9, "title": "leaf", "summary": "s", "bullets": []},
    ]


def _create_body(name: str) -> dict:
    return {"name": name, "graph": _graph(), "summaries": _summaries()}


@pytest.mark.asyncio
async def test_crud_happy_path():
    alice = await _make_user()
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)

            # Create
            created = await client.post(
                f"/api/projects/{pid}/snapshots", json=_create_body("snap one")
            )
            assert created.status_code == 201
            meta = created.json()
            sid = meta["id"]
            assert meta["seed_id"] == "n1"
            assert meta["node_count"] == 2
            assert meta["cluster_count"] == 2
            assert "graph" not in meta  # create/list responses never carry blobs

            # List (metadata only)
            listing = await client.get(f"/api/projects/{pid}/snapshots")
            assert listing.status_code == 200
            assert [s["id"] for s in listing.json()] == [sid]
            assert "graph" not in listing.json()[0]

            # Get (full payload — the load call)
            detail = (await client.get(f"/api/projects/{pid}/snapshots/{sid}")).json()
            assert detail["graph"]["seedId"] == "n1"
            assert len(detail["summaries"]) == 3

            # Rename
            renamed = await client.patch(
                f"/api/projects/{pid}/snapshots/{sid}", json={"name": "snap renamed"}
            )
            assert renamed.status_code == 200
            assert renamed.json()["name"] == "snap renamed"

            # Delete
            assert (
                await client.delete(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 204
            assert (await client.get(f"/api/projects/{pid}/snapshots")).json() == []


@pytest.mark.asyncio
async def test_cap_returns_409_on_fourth_create():
    alice = await _make_user()
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)
            for i in range(3):
                resp = await client.post(
                    f"/api/projects/{pid}/snapshots", json=_create_body(f"s{i}")
                )
                assert resp.status_code == 201
            fourth = await client.post(
                f"/api/projects/{pid}/snapshots", json=_create_body("s4")
            )
            assert fourth.status_code == 409
            assert "limit" in fourth.json()["detail"].lower()


@pytest.mark.asyncio
async def test_duplicate_name_conflicts():
    alice = await _make_user()
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)
            body = _create_body("dup")
            assert (
                await client.post(f"/api/projects/{pid}/snapshots", json=body)
            ).status_code == 201
            # Same name within the project → 409 (the unique constraint).
            assert (
                await client.post(f"/api/projects/{pid}/snapshots", json=body)
            ).status_code == 409


@pytest.mark.asyncio
async def test_cross_user_project_is_404():
    alice = await _make_user()
    bob = await _make_user()
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)
            sid = (
                await client.post(
                    f"/api/projects/{pid}/snapshots", json=_create_body("a")
                )
            ).json()["id"]

        # Bob can't see Alice's project, so every snapshot route 404s.
        with _as(bob):
            assert (
                await client.get(f"/api/projects/{pid}/snapshots")
            ).status_code == 404
            assert (
                await client.get(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 404
            assert (
                await client.post(
                    f"/api/projects/{pid}/snapshots", json=_create_body("x")
                )
            ).status_code == 404
            assert (
                await client.patch(
                    f"/api/projects/{pid}/snapshots/{sid}", json={"name": "y"}
                )
            ).status_code == 404
            assert (
                await client.delete(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 404


@pytest.mark.asyncio
async def test_deleting_project_cascades_to_snapshots():
    """End-to-end: DELETE /projects/{id} takes its snapshots with it, so the
    routes 404 afterwards (the project — and thus the ownership scope — is gone)."""
    alice = await _make_user()
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)
            sid = (
                await client.post(
                    f"/api/projects/{pid}/snapshots", json=_create_body("doomed")
                )
            ).json()["id"]
            assert (
                await client.get(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 200

            assert (await client.delete(f"/api/projects/{pid}")).status_code == 204

            # Project gone → ownership lookup 404s every snapshot route.
            assert (
                await client.get(f"/api/projects/{pid}/snapshots")
            ).status_code == 404
            assert (
                await client.get(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 404


@pytest.mark.asyncio
async def test_blob_round_trip_is_faithful():
    """The graph/summaries JSON must survive store→load byte-for-byte (by value),
    so a reload reconstructs the exact pipeline output that was saved."""
    alice = await _make_user()
    graph = {
        "nodes": [{"paper_id": "n1", "title": "Seed"}, {"paper_id": "n2"}],
        "edges": [{"source": "n1", "target": "n2"}],
        "seedId": "n1",
        "resolution": 1.25,
        "maxLevels": 7,
        "booleanQuery": "alpha AND beta",
        "keywords": ["alpha", "beta"],
        "prefiltered": True,
        "initialSeedIds": ["n1"],
        "directionalSplit": True,
    }
    summaries = [
        {"level": 1, "community": 0, "title": "T0", "summary": "s0", "bullets": ["a", "b"]},
        {"level": 0, "community": 5, "title": "T5", "summary": "s5", "bullets": []},
    ]
    async with _client() as client:
        with _as(alice):
            pid = await _make_project(client)
            sid = (
                await client.post(
                    f"/api/projects/{pid}/snapshots",
                    json={"name": "round trip", "graph": graph, "summaries": summaries},
                )
            ).json()["id"]
            detail = (
                await client.get(f"/api/projects/{pid}/snapshots/{sid}")
            ).json()
            assert detail["graph"] == graph
            assert detail["summaries"] == summaries


@pytest.mark.asyncio
async def test_guest_null_bucket_can_crud():
    """Signed-out callers CRUD snapshots under a null-owned project (back-compat)."""
    async with _client() as client:
        with _as(None):
            pid = await _make_project(client)
            sid = (
                await client.post(
                    f"/api/projects/{pid}/snapshots", json=_create_body("guest")
                )
            ).json()["id"]
            assert any(
                s["id"] == sid
                for s in (await client.get(f"/api/projects/{pid}/snapshots")).json()
            )
            assert (
                await client.get(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 200
            assert (
                await client.delete(f"/api/projects/{pid}/snapshots/{sid}")
            ).status_code == 204
