"""End-to-end tests for the /api/auth/* OAuth sign-in endpoints.

The full provider round-trip can't run offline, so these cover the parts that
don't need a live provider: session-gated access, the provider list, unknown
providers, and that a configured provider produces an authorize redirect.
"""
from __future__ import annotations

import pytest
import httpx

from app.main import app
from app.api import auth as auth_module
from app.auth.config import oauth


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


@pytest.mark.asyncio
async def test_me_unauthenticated_is_401():
    async with _client() as client:
        resp = await client.get("/api/auth/me")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_logout_is_noop_without_session():
    async with _client() as client:
        resp = await client.post("/api/auth/logout")
        assert resp.status_code == 204


@pytest.mark.asyncio
async def test_providers_returns_list():
    async with _client() as client:
        resp = await client.get("/api/auth/providers")
        assert resp.status_code == 200
        assert isinstance(resp.json()["providers"], list)


@pytest.mark.asyncio
async def test_login_unknown_provider_is_404():
    async with _client() as client:
        resp = await client.get("/api/auth/login/nope")
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_login_configured_provider_redirects(monkeypatch):
    # Register a fake non-OIDC provider so authorize_redirect needs no network.
    name = "faketest"
    if name not in oauth._clients:
        oauth.register(
            name=name,
            client_id="fake-id",
            client_secret="fake-secret",
            authorize_url="https://example.com/oauth/authorize",
            access_token_url="https://example.com/oauth/token",
            client_kwargs={"scope": "openid"},
        )
    monkeypatch.setattr(auth_module, "configured_providers", lambda: [name])

    async with _client() as client:
        resp = await client.get("/api/auth/login/faketest")
        assert resp.status_code in (302, 307)
        assert resp.headers["location"].startswith("https://example.com/oauth/authorize")
