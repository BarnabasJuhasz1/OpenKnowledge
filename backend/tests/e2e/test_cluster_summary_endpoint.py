"""End-to-end tests for /api/clusters/summarize.

Without a GOOGLE_API_KEY the deterministic fallback is exercised; one test
stubs the gemma HTTP call with respx to exercise the live-model path.
"""
from __future__ import annotations

import json

import httpx
import pytest
import respx

from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_finest_fallback_endpoint(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    async with _client() as client:
        resp = await client.post(
            "/api/clusters/summarize",
            json={
                "kind": "finest",
                "name": "Cluster 0",
                "papers": [
                    {"title": "Paper A", "abstract": "about graphs", "archetypes": ["Method"]},
                    {"title": "Paper B", "abstract": "about graphs too"},
                ],
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["method"] == "fallback"
    assert data["title"] and data["summary"]


@pytest.mark.asyncio
async def test_higher_fallback_endpoint(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    async with _client() as client:
        resp = await client.post(
            "/api/clusters/summarize",
            json={
                "kind": "higher",
                "children": [
                    {"title": "Sub 1", "summary": "self-attention models"},
                    {"title": "Sub 2", "summary": "pretraining objectives"},
                ],
            },
        )
    assert resp.status_code == 200
    assert resp.json()["summary"]


@pytest.mark.asyncio
async def test_bad_kind_rejected(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    async with _client() as client:
        resp = await client.post("/api/clusters/summarize", json={"kind": "weird"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_finest_without_papers_rejected(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    async with _client() as client:
        resp = await client.post("/api/clusters/summarize", json={"kind": "finest", "papers": []})
    assert resp.status_code == 422


@pytest.mark.asyncio
@respx.mock
async def test_gemma_path(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    payload_text = json.dumps({"title": "Graph Neural Networks", "summary": "A coherent body of work."})
    route = respx.route(method="POST", url__regex=r".*generateContent.*").mock(
        return_value=httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": payload_text}]}}]},
        )
    )
    async with _client() as client:
        resp = await client.post(
            "/api/clusters/summarize",
            json={"kind": "finest", "papers": [{"title": "GCN", "abstract": "graphs"}]},
        )
    assert route.called
    req_body = json.loads(route.calls.last.request.content)
    assert req_body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0
    assert resp.status_code == 200
    data = resp.json()
    assert data["method"] == "gemma"
    assert data["title"] == "Graph Neural Networks"
    assert data["summary"] == "A coherent body of work."
