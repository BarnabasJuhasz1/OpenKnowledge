"""Unit tests for the archetype classifier service (worker stubbed out)."""

from __future__ import annotations

import pytest

from app.models.paper import Paper
from app.services.archetype import classifier
from app.services.archetype import cache as archetype_cache


@pytest.fixture(autouse=True)
def _clear_archetype_cache():
    """The classification cache is process-wide; keep each test hermetic."""
    archetype_cache.clear()
    yield
    archetype_cache.clear()


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
async def test_cached_papers_are_not_reclassified(monkeypatch):
    worker = _FakeWorker()
    _patch_worker(monkeypatch, worker)

    p1 = Paper(title="t1", abstract="reused abstract", semantic_scholar_id="123")
    await classifier.classify_papers([p1])
    assert worker.received is not None and len(worker.received) == 1
    assert p1.predicted_main_archetype == "The Innovator"

    # A different paper with the same identity is served from cache: no new worker call.
    worker2 = _FakeWorker()
    _patch_worker(monkeypatch, worker2)
    p2 = Paper(title="t2", abstract="reused abstract", semantic_scholar_id="123")
    await classifier.classify_papers([p2])

    assert worker2.received is None  # cache hit — model not consulted
    assert p2.predicted_main_archetype == "The Innovator"
    assert p2.predicted_second_tier_archetype == "Algorithm/Architecture"


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


def test_load_config_env_overrides(monkeypatch, tmp_path):
    from app.services.archetype import config as arch_config

    # Hermetic: clear any ARCHETYPE_* vars a loaded .env may have set process-wide
    # (e.g. ARCHETYPE_CLASSIFIER_URL), so "no env vars → None" holds regardless of host.
    for key in [
        "ENABLED", "PYTHON_EXECUTABLE", "SCRIPT_PATH", "CHECKPOINT_DIR",
        "LABEL_MAPPING_PATH", "DEVICE", "CLASSIFIER_URL", "CLASSIFIER_API_KEY",
    ]:
        monkeypatch.delenv(f"ARCHETYPE_{key}", raising=False)

    # Mock config_path to return a non-existent file
    monkeypatch.setattr(arch_config, "config_path", lambda: tmp_path / "non_existent.json")

    # Without env vars, it should return None
    assert arch_config.load_config() is None

    # Set env vars
    monkeypatch.setenv("ARCHETYPE_ENABLED", "true")
    monkeypatch.setenv("ARCHETYPE_PYTHON_EXECUTABLE", "python-test")
    monkeypatch.setenv("ARCHETYPE_SCRIPT_PATH", "relative/path/to/script.py")

    # Mock path resolver to a known path
    fake_root = tmp_path / "project_root"
    monkeypatch.setattr(
        arch_config,
        "resolve_archetype_path",
        lambda rel_path: str((fake_root / rel_path).resolve())
    )

    cfg = arch_config.load_config()
    assert cfg is not None
    assert cfg["enabled"] is True
    assert cfg["python_executable"] == "python-test"
    # The relative path should be resolved relative to fake_root
    assert cfg["script_path"] == str((fake_root / "relative/path/to/script.py").resolve())


@pytest.mark.asyncio
async def test_worker_python_fallback(monkeypatch, tmp_path):
    from app.services.archetype.worker import ArchetypeWorker
    import sys

    # Config with non-existent python executable but valid script path
    fake_script = tmp_path / "script.py"
    fake_script.touch()

    cfg = {
        "python_executable": str(tmp_path / "non_existent_python"),
        "script_path": str(fake_script),
        "enabled": True
    }

    # Mock dependencies as present in current environment
    monkeypatch.setitem(sys.modules, "torch", type(sys)("torch"))
    monkeypatch.setitem(sys.modules, "transformers", type(sys)("transformers"))
    monkeypatch.setitem(sys.modules, "safetensors", type(sys)("safetensors"))

    worker = ArchetypeWorker(cfg)

    # Mock asyncio.create_subprocess_exec to record execution command
    spawned_cmd = None
    async def fake_create_subprocess_exec(*args, **kwargs):
        nonlocal spawned_cmd
        spawned_cmd = args
        class FakePipe:
            async def readline(self):
                return b'{"event": "ready"}\n'
            def __aiter__(self):
                return self
            async def __anext__(self):
                raise StopAsyncIteration
        class FakeProcess:
            def __init__(self):
                self.stdin = type("FakeStdin", (), {"write": lambda *args: None, "drain": lambda *args: None})()
                self.stdout = FakePipe()
                self.stderr = FakePipe()
                self.returncode = None
            def terminate(self):
                pass
        return FakeProcess()

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_create_subprocess_exec)

    success = await worker.start()
    assert success is True
    # The first arg of spawned_cmd should be sys.executable because it fell back
    assert spawned_cmd is not None
    assert spawned_cmd[0] == sys.executable
    await worker.aclose()


# ── Salvaged: ok-score helper + batched, ok-score-prioritized classification ──

import asyncio

import httpx


@pytest.mark.asyncio
async def test_compute_ok_score():
    from app.services.archetype.classifier import compute_ok_score

    p1 = Paper(title="1", citation_count=9, has_public_code=True)
    p2 = Paper(title="2", citation_count=99, is_peer_reviewed=True)

    assert compute_ok_score(p1) == 2.0
    assert compute_ok_score(p2) == 3.0


@pytest.mark.asyncio
async def test_batch_classifier_orders_by_ok_score(monkeypatch):
    from app.services.archetype.classifier import BatchClassifier

    classified_batches = []
    first_batch_started = asyncio.Event()
    first_batch_can_complete = asyncio.Event()

    async def fake_classify_papers(papers):
        for p in papers:
            p.predicted_main_archetype = "The Innovator"
        classified_batches.append(list(papers))
        if len(classified_batches) == 1:
            first_batch_started.set()
            await first_batch_can_complete.wait()

    monkeypatch.setattr(classifier, "classify_papers", fake_classify_papers)

    p_low = Paper(title="low", abstract="abstract", citation_count=0)
    p_mid = Paper(title="mid", abstract="abstract", citation_count=9)
    p_high = Paper(title="high", abstract="abstract", citation_count=99)

    queue = BatchClassifier(batch_size=1)

    await queue.add_papers([p_low, p_mid])
    queue.start()

    await first_batch_started.wait()

    # A higher-scoring paper arriving mid-run jumps ahead of the queued low one.
    await queue.add_papers([p_high])

    first_batch_can_complete.set()
    await queue.stop()

    assert len(classified_batches) == 3
    assert classified_batches[0][0].title == "mid"
    assert classified_batches[1][0].title == "high"
    assert classified_batches[2][0].title == "low"


# ── HTTP transport to the Cloud Run classifier ──

@pytest.mark.asyncio
async def test_http_worker_classifies(httpx_mock):
    from app.services.archetype.http_client import HttpArchetypeWorker

    httpx_mock.add_response(
        json={
            "results": [
                {
                    "id": "0",
                    "primary": "The Innovator",
                    "secondary": "Algorithm/Architecture",
                    "main_confidence": 0.9,
                    "second_confidence": 0.8,
                }
            ]
        }
    )
    worker = HttpArchetypeWorker({"classifier_url": "https://clf.example"})
    res = await worker.classify([{"id": "0", "abstract": "x"}])
    await worker.aclose()

    assert res["0"]["primary"] == "The Innovator"
    assert res["0"]["secondary"] == "Algorithm/Architecture"


@pytest.mark.asyncio
async def test_http_worker_swallows_errors(httpx_mock):
    from app.services.archetype.http_client import HttpArchetypeWorker

    httpx_mock.add_exception(httpx.ConnectError("boom"))
    worker = HttpArchetypeWorker({"classifier_url": "https://clf.example"})
    res = await worker.classify([{"id": "0", "abstract": "x"}])
    await worker.aclose()

    assert res == {}
