"""End-to-end tests for /api/clusters/summarize (Server-Sent Events).

Without VLLM_BASE_URL the deterministic fallback is streamed; one test stubs the
vLLM OpenAI client to exercise the live streaming-model path.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from app.main import app
from app.services import llm_client


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _events(body: str) -> list[dict]:
    """Parse an SSE payload into the list of JSON event objects."""
    events: list[dict] = []
    for block in body.strip().split("\n\n"):
        data = "".join(
            line[len("data:"):].strip()
            for line in block.splitlines()
            if line.startswith("data:")
        )
        if data:
            events.append(json.loads(data))
    return events


# --- fake vLLM streaming client ------------------------------------------------

class _FakeStream:
    def __init__(self, deltas: list[str]):
        self._deltas = deltas

    def __aiter__(self):
        async def gen():
            for d in self._deltas:
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=d))]
                )
        return gen()


def _fake_client(deltas: list[str]):
    async def create(**kwargs):
        assert kwargs["stream"] is True
        return _FakeStream(deltas)

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


@pytest.mark.asyncio
async def test_finest_fallback_endpoint(monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
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
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _events(resp.text)
    done = events[-1]
    assert done["done"] is True
    assert done["method"] == "fallback"
    assert done["title"] and done["summary"]


@pytest.mark.asyncio
async def test_higher_fallback_endpoint(monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
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
    assert _events(resp.text)[-1]["summary"]


@pytest.mark.asyncio
async def test_bad_kind_rejected(monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    async with _client() as client:
        resp = await client.post("/api/clusters/summarize", json={"kind": "weird"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_finest_without_papers_rejected(monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    async with _client() as client:
        resp = await client.post("/api/clusters/summarize", json={"kind": "finest", "papers": []})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_vllm_streaming_path(monkeypatch):
    monkeypatch.setenv("VLLM_BASE_URL", "http://model:8000/v1")
    monkeypatch.setenv("VLLM_MODEL_NAME", "test-model")
    deltas = ["Graph Neural Networks\n", "A coherent body ", "of work on GNNs."]
    monkeypatch.setattr(llm_client, "vllm_client", lambda: _fake_client(deltas))

    async with _client() as client:
        resp = await client.post(
            "/api/clusters/summarize",
            json={"kind": "finest", "papers": [{"title": "GCN", "abstract": "graphs"}]},
        )
    assert resp.status_code == 200
    events = _events(resp.text)
    streamed = "".join(e["delta"] for e in events if "delta" in e)
    assert streamed == "".join(deltas)  # tokens forwarded live
    done = events[-1]
    assert done["method"] == "vllm"
    assert done["model"] == "test-model"
    assert done["title"] == "Graph Neural Networks"
    assert done["summary"] == "A coherent body of work on GNNs."
