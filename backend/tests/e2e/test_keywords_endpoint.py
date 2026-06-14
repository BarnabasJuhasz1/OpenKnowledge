"""End-to-end tests for the /api/keywords endpoints.

No VLLM_BASE_URL is set in the test env, so generation uses the local
heuristic fallback.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import httpx
from app.main import app
from app.services import llm_client


@pytest.fixture(autouse=True)
def _no_llm(monkeypatch):
    """Force the offline heuristic path so these tests never hit the live model,
    even when a VLLM_BASE_URL is present in the backend .env."""
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


@pytest.mark.asyncio
async def test_generate_from_prompt():
    async with _client() as client:
        resp = await client.post(
            "/api/keywords/generate",
            json={"prompt": "I want to know about model compression techniques"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["method"] == "heuristic"  # no API key in tests
        assert data["keywords"], "expected keywords"
        assert isinstance(data["query"], str) and data["query"]


@pytest.mark.asyncio
async def test_generate_with_bibtex_context():
    bibtex = (
        "@article{a, title={Pruning Deep Nets}, "
        "keywords={network pruning, sparsity}, year={2021}}"
    )
    async with _client() as client:
        resp = await client.post(
            "/api/keywords/generate",
            json={"prompt": "compressing neural networks", "bibtex": bibtex},
        )
        assert resp.status_code == 200
        low = [k.lower() for k in resp.json()["keywords"]]
        assert "network pruning" in low or "sparsity" in low


@pytest.mark.asyncio
async def test_blank_input_rejected():
    async with _client() as client:
        resp = await client.post("/api/keywords/generate", json={"prompt": "   "})
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_generate_via_vllm(monkeypatch):
    """The vLLM path: a stubbed OpenAI completion returning a JSON array."""
    monkeypatch.setenv("VLLM_BASE_URL", "http://model:8000/v1")
    monkeypatch.setenv("VLLM_MODEL_NAME", "test-model")
    content = json.dumps(['("LLM" OR "large language model")', '("pruning" OR "compression")'])

    async def create(**kwargs):
        assert kwargs["stream"] is False
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )

    fake = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(llm_client, "vllm_client", lambda: fake)

    async with _client() as client:
        resp = await client.post(
            "/api/keywords/generate",
            json={"prompt": "pruning large language models"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["method"] == "vllm"
    assert data["model"] == "test-model"
    assert len(data["keywords"]) == 2
