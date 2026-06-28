"""project-ownership-02: ownership-aware scoping of project endpoints.

Authenticated callers only see/touch their own projects; unauthenticated callers
operate on the `user_id IS NULL` guest bucket. Inaccessible projects 404 (never
403) so their existence isn't leaked.

Auth is simulated by overriding the `optional_current_user` dependency rather
than driving the real OAuth flow.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager

import httpx
import pytest

from app.api.auth import optional_current_user
from app.db.database import AsyncSessionLocal
from app.db.orm_models import DBProject, DBUser
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
    """Run requests inside the block as `user` (or unauthenticated if None)."""
    app.dependency_overrides[optional_current_user] = lambda: user
    try:
        yield
    finally:
        app.dependency_overrides.pop(optional_current_user, None)


@pytest.mark.asyncio
async def test_create_stamps_owner_and_list_is_scoped():
    alice = await _make_user()
    bob = await _make_user()
    name = f"Alice proj {uuid.uuid4()}"

    async with _client() as client:
        with _as(alice):
            created = await client.post("/api/projects", json={"name": name})
            assert created.status_code == 201
            pid = created.json()["id"]

            listing = await client.get("/api/projects")
            assert listing.status_code == 200
            assert any(p["id"] == pid for p in listing.json())

        # Bob doesn't see Alice's project at all.
        with _as(bob):
            listing = await client.get("/api/projects")
            assert all(p["id"] != pid for p in listing.json())


@pytest.mark.asyncio
async def test_create_stamps_user_id_on_the_db_row():
    """Create writes the owner's id onto the row; signed-out writes NULL."""
    alice = await _make_user()

    async with _client() as client:
        with _as(alice):
            owned = (
                await client.post("/api/projects", json={"name": f"Owned {uuid.uuid4()}"})
            ).json()["id"]
        with _as(None):
            guest = (
                await client.post("/api/projects", json={"name": f"Guest {uuid.uuid4()}"})
            ).json()["id"]

    async with AsyncSessionLocal() as db:
        assert (await db.get(DBProject, owned)).user_id == alice.id
        assert (await db.get(DBProject, guest)).user_id is None


@pytest.mark.asyncio
async def test_require_project_guard_blocks_unauthenticated():
    """An owned project's guarded endpoint 404s for a signed-out caller."""
    alice = await _make_user()

    async with _client() as client:
        with _as(alice):
            pid = (
                await client.post("/api/projects", json={"name": f"A {uuid.uuid4()}"})
            ).json()["id"]
            # The owner can reach the guarded endpoint.
            assert (
                await client.get("/api/bookshelf", params={"project_id": pid})
            ).status_code == 200

        with _as(None):
            assert (
                await client.get("/api/bookshelf", params={"project_id": pid})
            ).status_code == 404


@pytest.mark.asyncio
async def test_cross_user_access_is_404():
    alice = await _make_user()
    bob = await _make_user()

    async with _client() as client:
        with _as(alice):
            pid = (
                await client.post("/api/projects", json={"name": f"A {uuid.uuid4()}"})
            ).json()["id"]

        with _as(bob):
            assert (await client.get(f"/api/projects/{pid}")).status_code == 404
            assert (
                await client.put(f"/api/projects/{pid}", json={"name": "hijack"})
            ).status_code == 404
            assert (await client.delete(f"/api/projects/{pid}")).status_code == 404
            # A require_project-guarded endpoint also 404s for the non-owner.
            assert (
                await client.get("/api/bookshelf", params={"project_id": pid})
            ).status_code == 404

        # Alice still owns it, untouched.
        with _as(alice):
            got = await client.get(f"/api/projects/{pid}")
            assert got.status_code == 200
            assert got.json()["name"].startswith("A ")


@pytest.mark.asyncio
async def test_unauthenticated_uses_null_bucket():
    """Signed-out create/list/get round-trips through the guest bucket (back-compat)."""
    name = f"Guest {uuid.uuid4()}"
    async with _client() as client:
        with _as(None):
            created = await client.post("/api/projects", json={"name": name})
            assert created.status_code == 201
            pid = created.json()["id"]

            assert any(p["id"] == pid for p in (await client.get("/api/projects")).json())
            assert (await client.get(f"/api/projects/{pid}")).status_code == 200

        # An authenticated user cannot see the guest-bucket project.
        carol = await _make_user()
        with _as(carol):
            assert (await client.get(f"/api/projects/{pid}")).status_code == 404
            assert all(p["id"] != pid for p in (await client.get("/api/projects")).json())
