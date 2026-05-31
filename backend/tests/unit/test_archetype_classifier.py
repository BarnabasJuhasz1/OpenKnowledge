"""Unit tests for the archetype classifier service (worker stubbed out)."""

from __future__ import annotations

import pytest

from app.models.paper import Paper
from app.services.archetype import classifier


class _FakeWorker:
    """Records the items it was asked to classify and returns canned labels."""

    def __init__(self, mapping=None, raises=False):
        self.mapping = mapping or {}
        self.raises = raises
        self.received: list[dict] | None = None

    async def classify(self, items):
        self.received = items
        if self.raises:
            raise RuntimeError("worker boom")
        # By default, label every item the same way.
        return {
            item["id"]: {
                "id": item["id"],
                "primary": "The Innovator",
                "secondary": "Algorithm/Architecture",
            }
            for item in items
        }


def _patch_worker(monkeypatch, worker):
    monkeypatch.setattr(classifier, "get_worker", lambda: worker)


@pytest.mark.asyncio
async def test_classifies_only_unlabeled_papers_with_abstracts(monkeypatch):
    worker = _FakeWorker()
    _patch_worker(monkeypatch, worker)

    papers = [
        Paper(title="needs it", abstract="a meaningful abstract"),
        Paper(title="blank abstract", abstract="   "),
        Paper(title="no abstract"),
        Paper(
            title="already classified",
            abstract="has one",
            predicted_main_archetype="The Synthesizer",
        ),
    ]

    await classifier.classify_papers(papers)

    # Only the first paper should have been sent to the worker.
    assert worker.received is not None
    assert len(worker.received) == 1
    assert worker.received[0]["abstract"] == "a meaningful abstract"

    assert papers[0].predicted_main_archetype == "The Innovator"
    assert papers[0].predicted_second_tier_archetype == "Algorithm/Architecture"
    assert papers[1].predicted_main_archetype is None
    assert papers[2].predicted_main_archetype is None
    # Pre-existing classification is left untouched.
    assert papers[3].predicted_main_archetype == "The Synthesizer"


@pytest.mark.asyncio
async def test_disabled_worker_is_a_noop(monkeypatch):
    _patch_worker(monkeypatch, None)
    papers = [Paper(title="x", abstract="y")]
    await classifier.classify_papers(papers)  # must not raise
    assert papers[0].predicted_main_archetype is None


@pytest.mark.asyncio
async def test_worker_error_is_swallowed(monkeypatch):
    worker = _FakeWorker(raises=True)
    _patch_worker(monkeypatch, worker)
    papers = [Paper(title="x", abstract="y")]
    await classifier.classify_papers(papers)  # must not raise
    assert papers[0].predicted_main_archetype is None


@pytest.mark.asyncio
async def test_empty_list_does_not_call_worker(monkeypatch):
    worker = _FakeWorker()
    _patch_worker(monkeypatch, worker)
    await classifier.classify_papers([])
    assert worker.received is None
