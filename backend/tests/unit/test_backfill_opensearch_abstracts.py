"""Unit tests for the OpenSearch abstract backfill push (subtask 05).

The script lives in ``scripts/`` (not an importable package), so it is loaded by file path —
same pattern as test_ingest_resume.py. Only the pure helpers (action shape, missing-id
classification) are tested here; the BigQuery/OpenSearch I/O is verified live. Band/checkpoint
behaviour is already covered by test_ingest_resume.py and is reused, not duplicated.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"

# ingest_resume must be importable by name (the script does `from ingest_resume import ...`).
_ir_path = _SCRIPTS / "ingest_resume.py"
_ir_spec = importlib.util.spec_from_file_location("ingest_resume", _ir_path)
ingest_resume = importlib.util.module_from_spec(_ir_spec)
sys.modules["ingest_resume"] = ingest_resume
_ir_spec.loader.exec_module(_ir_spec and ingest_resume)  # type: ignore[arg-type]

_MOD_PATH = _SCRIPTS / "backfill_opensearch_abstracts.py"
_spec = importlib.util.spec_from_file_location("backfill_opensearch_abstracts", _MOD_PATH)
backfill = importlib.util.module_from_spec(_spec)
sys.modules["backfill_opensearch_abstracts"] = backfill
_spec.loader.exec_module(backfill)  # type: ignore[union-attr]

row_to_update_action = backfill.row_to_update_action
is_missing_doc_error = backfill.is_missing_doc_error
classify_bulk_result = backfill.classify_bulk_result


# --- row_to_update_action --------------------------------------------------

def test_update_action_shape():
    action = row_to_update_action(12345, "recovered abstract text", "openalex", "papers")
    assert action == {
        "_op_type": "update",
        "_index": "papers",
        "_id": 12345,
        "doc": {"abstract": "recovered abstract text", "abstract_source": "openalex"},
    }
    # Partial update only — never doc_as_upsert (must not create bare abstract-only docs).
    assert "doc_as_upsert" not in action
    assert action["_op_type"] == "update"


# --- is_missing_doc_error / classify ---------------------------------------

def test_missing_doc_error_by_status():
    info = {"update": {"_id": 7, "status": 404,
                       "error": {"type": "document_missing_exception"}}}
    assert is_missing_doc_error(info) is True
    assert classify_bulk_result(False, info) == "missing"


def test_missing_doc_error_by_type_only():
    info = {"update": {"error": {"type": "document_missing_exception"}}}
    assert is_missing_doc_error(info) is True


def test_other_error_is_not_missing():
    info = {"update": {"status": 400, "error": {"type": "mapper_parsing_exception"}}}
    assert is_missing_doc_error(info) is False
    assert classify_bulk_result(False, info) == "error"


def test_ok_result_classified_ok():
    info = {"update": {"_id": 7, "status": 200, "result": "updated"}}
    assert classify_bulk_result(True, info) == "ok"


# --- band/checkpoint reuse (smoke) -----------------------------------------

def test_reuses_ingest_resume_primitives():
    # The push script depends on the same resume primitives the main loader uses; their
    # behaviour is exercised in detail by test_ingest_resume.py. Confirm they are wired in.
    bands = backfill.compute_bands(corpusid_max=25, band_width=10)
    assert [b.index for b in bands] == [0, 1, 2]
    assert backfill.Checkpoint is ingest_resume.Checkpoint
    assert backfill.with_retries is ingest_resume.with_retries
