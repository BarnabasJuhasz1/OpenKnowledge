"""Unit tests for the cluster summary service (fallback path + JSON parsing)."""
from __future__ import annotations

import pytest

from app.services.cluster_summary import (
    summarize_cluster,
    PaperInput,
    ChildInput,
)
from app.services.cluster_summary.gemma import _parse_summary, _answer_text


@pytest.fixture(autouse=True)
def _no_llm_key(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)


@pytest.mark.asyncio
async def test_finest_fallback():
    papers = [
        PaperInput(title="Attention Is All You Need", abstract="transformers", archetypes=["Method"]),
        PaperInput(title="BERT", abstract="masked LM", archetypes=["Method"]),
    ]
    res = await summarize_cluster("finest", papers=papers, name="Cluster 0")
    assert res.method == "fallback"
    assert res.title
    assert res.summary
    assert "2" in res.summary  # mentions the count


@pytest.mark.asyncio
async def test_higher_fallback():
    children = [
        ChildInput(title="Transformers", summary="self-attention models"),
        ChildInput(title="Pretraining", summary="masked language modelling"),
    ]
    res = await summarize_cluster("higher", children=children)
    assert res.method == "fallback"
    assert res.title
    assert "Transformers" in res.summary


def test_parse_clean_json():
    title, summary = _parse_summary('{"title": "Graph Learning", "summary": "A body of work."}')
    assert title == "Graph Learning"
    assert summary == "A body of work."


def test_parse_fenced_json():
    text = '```json\n{"title": "T", "summary": "S"}\n```'
    assert _parse_summary(text) == ("T", "S")


def test_parse_prose_wrapped_json_takes_last():
    text = (
        'Here is an example {"title": "ex", "summary": "old"}.\n'
        'Final answer: {"title": "Real", "summary": "new"}'
    )
    title, summary = _parse_summary(text)
    assert title == "Real"
    assert summary == "new"


def test_parse_no_json_returns_empty_for_fallback():
    # Unparseable prose → empty so the caller uses the deterministic fallback
    # instead of dumping the model's reasoning monologue.
    title, summary = _parse_summary("Just some prose with no JSON and no fields.")
    assert title == ""
    assert summary == ""


def test_parse_prose_title_summary_fields():
    text = "Title: Graph Neural Networks\nSummary: A coherent body of work on GNNs."
    title, summary = _parse_summary(text)
    assert title == "Graph Neural Networks"
    assert summary.startswith("A coherent body")


def test_answer_text_skips_thought_parts():
    parts = [
        {"text": "Let me reason about this cluster...", "thought": True},
        {"text": '{"title": "T", "summary": "S"}'},
    ]
    assert _answer_text(parts) == '{"title": "T", "summary": "S"}'


def test_answer_text_empty_when_only_thoughts():
    parts = [{"text": "thinking...", "thought": True}]
    assert _answer_text(parts) == ""
