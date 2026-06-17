"""Unit tests for project ok-score enrichment of citation-graph nodes.

`_enrichment_map` joins live citgraph nodes to the active project's stored papers
(by DOI then arXiv id) and `_to_response` folds the matched enrichment fields into
the API response, defaulting unmatched nodes to neutral values.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import delete

from app.api.citgraph import _enrichment_map, _to_response
from app.db.database import AsyncSessionLocal
from app.db.orm_models import DBPaper

PROJECT_ID = 424242


def _node(paper_id: str, *, doi=None, arxiv_id=None) -> SimpleNamespace:
    return SimpleNamespace(
        paper_id=paper_id,
        doi=doi,
        arxiv_id=arxiv_id,
        title=f"title {paper_id}",
        abstract=None,
        year=2021,
        citation_count=10,
        reference_count=5,
        authors=[],
        journal=None,
        is_open_access=False,
        pdf_url=None,
        fields_of_study=[],
        hop=0,
        predicted_main_archetype=None,
        predicted_second_tier_archetype=None,
    )


@pytest.fixture
async def seeded_papers():
    async with AsyncSessionLocal() as db:
        await db.execute(delete(DBPaper).where(DBPaper.project_id == PROJECT_ID))
        db.add_all([
            DBPaper(
                project_id=PROJECT_ID, title="coded", doi="10.1/ABC",
                has_public_code=True, is_peer_reviewed=True,
                has_dataset=True, repo_stars=42,
            ),
            DBPaper(
                project_id=PROJECT_ID, title="arxiv-only", arxiv_id="2101.00001",
                has_public_code=False, is_peer_reviewed=True,
                has_dataset=False, repo_stars=7,
            ),
        ])
        await db.commit()
    yield
    async with AsyncSessionLocal() as db:
        await db.execute(delete(DBPaper).where(DBPaper.project_id == PROJECT_ID))
        await db.commit()


async def test_enrichment_map_matches_by_doi_case_insensitive(seeded_papers):
    nodes = [_node("n1", doi="10.1/abc")]  # lower-case DOI must still match
    async with AsyncSessionLocal() as db:
        out = await _enrichment_map(nodes, PROJECT_ID, db)
    assert out["n1"] == {
        "has_public_code": True,
        "is_peer_reviewed": True,
        "has_dataset": True,
        "repo_stars": 42,
    }


async def test_enrichment_map_matches_by_arxiv_and_skips_unknown(seeded_papers):
    nodes = [_node("n2", arxiv_id="2101.00001"), _node("n3", doi="10.9/nope")]
    async with AsyncSessionLocal() as db:
        out = await _enrichment_map(nodes, PROJECT_ID, db)
    assert out["n2"]["repo_stars"] == 7
    assert "n3" not in out  # no project paper matched → no entry


async def test_enrichment_map_empty_without_project():
    nodes = [_node("n1", doi="10.1/ABC")]
    async with AsyncSessionLocal() as db:
        assert await _enrichment_map(nodes, None, db) == {}


def test_to_response_folds_enrichment_with_defaults():
    result = SimpleNamespace(
        nodes=[_node("n1", doi="10.1/ABC"), _node("n2")],
        edges=[],
        seed_id="n1",
    )
    enrich = {"n1": {
        "has_public_code": True, "is_peer_reviewed": False,
        "has_dataset": True, "repo_stars": 99,
    }}
    resp = _to_response(result, enrich)
    matched, unmatched = resp.nodes[0], resp.nodes[1]
    assert (matched.has_public_code, matched.has_dataset, matched.repo_stars) == (True, True, 99)
    # Unmatched node falls back to neutral defaults.
    assert unmatched.has_public_code is None
    assert unmatched.has_dataset is False
    assert unmatched.repo_stars == 0
