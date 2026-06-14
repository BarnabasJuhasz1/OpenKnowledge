"""Unit tests for the cluster summary service (fallback path + text parsing)."""
from __future__ import annotations

import pytest

from app.services.cluster_summary import (
    stream_cluster_summary,
    PaperInput,
    ChildInput,
)
from app.services.cluster_summary.vllm import parse_title_summary


@pytest.fixture(autouse=True)
def _no_vllm(monkeypatch):
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)


async def _final_event(agen) -> dict:
    """Drain the event stream and return the terminal `done` event."""
    done: dict | None = None
    async for event in agen:
        if event.get("done"):
            done = event
    assert done is not None
    return done


@pytest.mark.asyncio
async def test_finest_fallback():
    papers = [
        PaperInput(title="Attention Is All You Need", abstract="transformers", archetypes=["Method"]),
        PaperInput(title="BERT", abstract="masked LM", archetypes=["Method"]),
    ]
    done = await _final_event(stream_cluster_summary("finest", papers=papers, name="Cluster 0"))
    assert done["method"] == "fallback"
    assert done["title"]
    assert done["summary"]
    assert "2" in done["summary"]  # mentions the count


@pytest.mark.asyncio
async def test_higher_fallback():
    children = [
        ChildInput(title="Transformers", summary="self-attention models"),
        ChildInput(title="Pretraining", summary="masked language modelling"),
    ]
    done = await _final_event(stream_cluster_summary("higher", children=children))
    assert done["method"] == "fallback"
    assert done["title"]
    assert "Transformers" in done["summary"]


def test_parse_plain_text_title_then_summary():
    title, summary = parse_title_summary("Graph Learning\nA coherent body of work on graphs.")
    assert title == "Graph Learning"
    assert summary == "A coherent body of work on graphs."


def test_parse_strips_title_summary_labels():
    text = "Title: Graph Neural Networks\nSummary: A coherent body of work on GNNs."
    title, summary = parse_title_summary(text)
    assert title == "Graph Neural Networks"
    assert summary.startswith("A coherent body")


def test_parse_tolerates_clean_json():
    title, summary = parse_title_summary('{"title": "Graph Learning", "summary": "A body of work."}')
    assert title == "Graph Learning"
    assert summary == "A body of work."


def test_parse_tolerates_fenced_json():
    assert parse_title_summary('```json\n{"title": "T", "summary": "S"}\n```') == ("T", "S")


def test_parse_single_line_is_summary_without_title():
    title, summary = parse_title_summary("A standalone one-line summary.")
    assert title == ""
    assert summary == "A standalone one-line summary."


def test_parse_empty_returns_empty_for_fallback():
    assert parse_title_summary("   \n  ") == ("", "")
