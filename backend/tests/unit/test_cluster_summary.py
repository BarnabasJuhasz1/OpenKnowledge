"""Unit tests for the cluster summary service (fallback path + text parsing)."""
from __future__ import annotations

import pytest

import app.services.cluster_summary as cs
from app.services.cluster_summary import (
    stream_cluster_summary,
    PaperInput,
    ChildInput,
    SiblingInput,
)
from app.services.cluster_summary.vllm import parse_title_summary, parse_summary


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


def test_sibling_block_empty_when_no_siblings():
    assert cs._sibling_block([]) == ""


def test_finest_user_includes_sibling_roster():
    papers = [PaperInput(title="A small specialized paper", abstract="x", archetypes=["Method"])]
    siblings = [
        SiblingInput(title="Big general cluster", size=42, archetypes=["Survey", "Theory"]),
        SiblingInput(title="Another neighbour", size=1, archetypes=[]),
    ]
    user = cs._finest_user(papers, "Cluster 3", siblings)
    assert "Other clusters at this same level (2)" in user
    assert "Big general cluster (42 papers; archetypes: Survey, Theory)" in user
    assert "Another neighbour (1 paper; archetypes: n/a)" in user
    # Contrastive instruction steers toward distinctiveness.
    assert "distinct" in user


def test_higher_user_includes_sibling_roster():
    children = [ChildInput(title="Transformers", summary="self-attention models")]
    siblings = [SiblingInput(title="Graph methods", size=5, archetypes=["Method"])]
    user = cs._higher_user(children, "", siblings)
    assert "Other clusters at this same level (1)" in user
    assert "Graph methods (5 papers; archetypes: Method)" in user


@pytest.mark.asyncio
async def test_finest_fallback_accepts_siblings():
    papers = [PaperInput(title="Attention Is All You Need", abstract="t", archetypes=["Method"])]
    siblings = [SiblingInput(title="Neighbour", size=3, archetypes=["Survey"])]
    done = await _final_event(
        stream_cluster_summary("finest", papers=papers, siblings=siblings, name="Cluster 0")
    )
    assert done["method"] == "fallback"
    assert done["summary"]


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


def test_parse_summary_splits_prose_and_bullets():
    text = (
        "Scalable Language Models\n"
        "A coherent body of work on large pretrained transformers.\n"
        "###\n"
        "- scalable self-attention models: BERT, GPT-3\n"
        "- specialized programming models: code generation\n"
        "- common goal: improving efficiency\n"
    )
    title, summary, bullets = parse_summary(text)
    assert title == "Scalable Language Models"
    assert summary == "A coherent body of work on large pretrained transformers."
    assert bullets == [
        "scalable self-attention models: BERT, GPT-3",
        "specialized programming models: code generation",
        "common goal: improving efficiency",
    ]


def test_parse_summary_caps_at_three_and_strips_varied_markers():
    text = "T\nS\n###\n* one\n2) two\n• three\n- four\n"
    _, _, bullets = parse_summary(text)
    assert bullets == ["one", "two", "three"]


def test_parse_summary_keeps_leading_digit_words():
    # A "3D ..." phrase must not be mistaken for a numbered-list marker.
    _, _, bullets = parse_summary("T\nS\n###\n- 3D reconstruction methods\n")
    assert bullets == ["3D reconstruction methods"]


def test_parse_summary_without_separator_has_no_bullets():
    title, summary, bullets = parse_summary("Graph Learning\nA body of work on graphs.")
    assert title == "Graph Learning"
    assert summary == "A body of work on graphs."
    assert bullets == []


def test_parse_summary_tolerates_json_with_bullets():
    title, summary, bullets = parse_summary(
        '{"title": "T", "summary": "S", "bullets": ["a", "b", "c", "d"]}'
    )
    assert (title, summary) == ("T", "S")
    assert bullets == ["a", "b", "c"]  # capped at 3


@pytest.mark.asyncio
async def test_finest_fallback_emits_bullets():
    papers = [
        PaperInput(title="Attention Is All You Need", abstract="t", archetypes=["Method"]),
        PaperInput(title="BERT", abstract="m", archetypes=["Method"]),
    ]
    done = await _final_event(stream_cluster_summary("finest", papers=papers))
    assert done["method"] == "fallback"
    assert isinstance(done["bullets"], list) and done["bullets"]
