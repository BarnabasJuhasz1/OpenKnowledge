"""Unit tests for the resumable-ingestion primitives (bands / checkpoint / retry).

The loader lives in ``scripts/`` which is not an importable package, so the module is
loaded by file path. Only the pure stdlib helpers are tested here; the BigQuery/OpenSearch
I/O wiring in ``ingest_opensearch.py`` is verified live, not in unit tests.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ingest_resume.py"
_spec = importlib.util.spec_from_file_location("ingest_resume", _MODULE_PATH)
ingest_resume = importlib.util.module_from_spec(_spec)
# Register before exec so @dataclass can resolve the module via sys.modules.
sys.modules["ingest_resume"] = ingest_resume
_spec.loader.exec_module(ingest_resume)  # type: ignore[union-attr]

Band = ingest_resume.Band
compute_bands = ingest_resume.compute_bands
Checkpoint = ingest_resume.Checkpoint
with_retries = ingest_resume.with_retries


# --- compute_bands ---------------------------------------------------------

def test_compute_bands_basic_and_last_band_inclusive():
    bands = compute_bands(corpusid_max=25, band_width=10)
    assert bands == [Band(0, 0, 10), Band(1, 10, 20), Band(2, 20, 26)]
    # last band hi includes the max id (26 == 25 + 1)
    assert bands[-1].hi == 26


def test_compute_bands_exact_multiple():
    bands = compute_bands(corpusid_max=19, band_width=10)
    assert bands == [Band(0, 0, 10), Band(1, 10, 20)]


def test_compute_bands_single_band_when_width_exceeds_max():
    assert compute_bands(corpusid_max=5, band_width=1000) == [Band(0, 0, 6)]


def test_compute_bands_empty_and_bad_width():
    assert compute_bands(corpusid_max=-1, band_width=10) == []
    with pytest.raises(ValueError):
        compute_bands(corpusid_max=10, band_width=0)


# --- Checkpoint ------------------------------------------------------------

def test_checkpoint_roundtrip_and_resume(tmp_path):
    p = str(tmp_path / "ckpt.json")
    ck = Checkpoint.load_or_init(p, band_width=10, corpusid_max=100)
    assert ck.completed_count == 0
    ck.mark_done(0)
    ck.mark_done(3)

    # Reload with matching params -> resumes the done set.
    ck2 = Checkpoint.load_or_init(p, band_width=10, corpusid_max=100)
    assert ck2.is_done(0) and ck2.is_done(3) and not ck2.is_done(1)
    assert ck2.completed_count == 2

    bands = compute_bands(corpusid_max=39, band_width=10)  # bands 0..3
    remaining = ck2.remaining(bands)
    assert [b.index for b in remaining] == [1, 2]


def test_checkpoint_saved_atomically_no_tmp_left(tmp_path):
    p = tmp_path / "ckpt.json"
    ck = Checkpoint.load_or_init(str(p), band_width=10, corpusid_max=100)
    ck.mark_done(1)
    assert p.exists()
    assert not (tmp_path / "ckpt.json.tmp").exists()  # temp swapped, not left behind
    body = json.loads(p.read_text())
    assert body["completed_bands"] == [1]
    assert body["band_width"] == 10 and body["corpusid_max"] == 100


def test_checkpoint_stale_params_reset(tmp_path):
    p = str(tmp_path / "ckpt.json")
    Checkpoint.load_or_init(p, band_width=10, corpusid_max=100).mark_done(5)
    # Different band_width invalidates band indices -> fresh checkpoint.
    ck = Checkpoint.load_or_init(p, band_width=20, corpusid_max=100)
    assert ck.completed_count == 0
    # Different corpusid_max likewise.
    Checkpoint.load_or_init(p, band_width=10, corpusid_max=100).mark_done(5)
    ck2 = Checkpoint.load_or_init(p, band_width=10, corpusid_max=999)
    assert ck2.completed_count == 0


def test_checkpoint_corrupt_file_recovers(tmp_path):
    p = tmp_path / "ckpt.json"
    p.write_text("{not json")
    ck = Checkpoint.load_or_init(str(p), band_width=10, corpusid_max=100)
    assert ck.completed_count == 0
    ck.mark_done(2)  # still usable
    assert Checkpoint.load_or_init(str(p), 10, 100).is_done(2)


# --- with_retries ----------------------------------------------------------

def test_with_retries_success_first_try():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        return "ok"

    out = with_retries(fn, attempts=3, base_delay=1, max_delay=10,
                       exceptions=(RuntimeError,), sleep=lambda *_: None)
    assert out == "ok" and calls["n"] == 1


def test_with_retries_succeeds_after_failures():
    calls = {"n": 0}
    delays: list[float] = []

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient")
        return 42

    out = with_retries(fn, attempts=5, base_delay=2, max_delay=100,
                       exceptions=(RuntimeError,), sleep=delays.append)
    assert out == 42 and calls["n"] == 3
    assert delays == [2, 4]  # exponential backoff before tries 2 and 3


def test_with_retries_exhausts_and_reraises():
    def fn():
        raise RuntimeError("always")

    with pytest.raises(RuntimeError, match="always"):
        with_retries(fn, attempts=3, base_delay=1, max_delay=1,
                     exceptions=(RuntimeError,), sleep=lambda *_: None)


def test_with_retries_does_not_catch_unlisted_exception():
    def fn():
        raise KeyError("nope")

    with pytest.raises(KeyError):
        with_retries(fn, attempts=3, base_delay=1, max_delay=1,
                     exceptions=(RuntimeError,), sleep=lambda *_: None)


def test_with_retries_backoff_caps_at_max_delay():
    delays: list[float] = []
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise RuntimeError("x")

    with pytest.raises(RuntimeError):
        with_retries(fn, attempts=5, base_delay=10, max_delay=25,
                     exceptions=(RuntimeError,), sleep=delays.append)
    # base*2^(n-1): 10, 20, 40->cap25, 80->cap25 ; 4 sleeps before the 5th (final) try
    assert delays == [10, 20, 25, 25]
