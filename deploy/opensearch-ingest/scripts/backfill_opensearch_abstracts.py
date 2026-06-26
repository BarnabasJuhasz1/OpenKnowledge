#!/usr/bin/env python
"""Push backfilled abstracts into OpenSearch as targeted partial updates (subtask 05).

The recovered abstracts live in BigQuery `semantic_scholar.abstracts_openalex` (filled by the
API/bulk paths and merged into papers_search in subtask 04). This script makes OpenSearch
serve them **exactly like native S2 abstracts** — same `abstract` field, same BM25 — WITHOUT
reindexing 235M docs. Because the main loader sets `_id = corpusid`, we issue OpenSearch bulk
`update` actions that set only `abstract` (+ `abstract_source`) on the existing doc: cheap,
idempotent, no full reindex.

Reads `(corpusid, abstract, source)` from `abstracts_openalex` via the BigQuery Storage Read
API (same pattern as ingest_opensearch.py) and resumes by corpusid bands (ingest_resume.py)
with a SEPARATE checkpoint. An `update` on a not-yet-ingested `_id` errors — those are counted
and logged as skipped, never fatal; `doc_as_upsert` is OFF (we never create abstract-only docs).

This is the production copy (dockerised OpenSearch on the VM: self-signed TLS + basic auth).
The dev copy backend/scripts/backfill_opensearch_abstracts.py differs only in the OpenSearch
client block — keep the rest identical.

Usage:
    python scripts/backfill_opensearch_abstracts.py                 # push all backfilled rows
    python scripts/backfill_opensearch_abstracts.py --max-docs 1000 # pilot sample
    python scripts/backfill_opensearch_abstracts.py --band-width 1000000

Env (.env): BIGQUERY_DATASET_REF, OPENSEARCH_URL, OPENSEARCH_INDEX.
"""
from __future__ import annotations

import argparse
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv

from ingest_resume import Checkpoint, compute_bands, with_retries

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_os")

_DEFAULT_CHECKPOINT = Path(__file__).resolve().parent / ".backfill_os_checkpoint.json"
_BACKFILL_TABLE = "abstracts_openalex"
_COLUMNS = ["corpusid", "abstract", "source"]


# ---------------------------------------------------------------------------
# Pure helpers (unit-test anchors)
# ---------------------------------------------------------------------------

def row_to_update_action(corpusid: int, abstract: str, source: str, index: str) -> dict:
    """A partial-update bulk action: set only abstract + abstract_source on the existing doc.

    No `doc_as_upsert` — updating a missing `_id` must fail (and be skipped), never create a
    bare abstract-only doc.
    """
    return {
        "_op_type": "update",
        "_index": index,
        "_id": corpusid,
        "doc": {"abstract": abstract, "abstract_source": source},
    }


def is_missing_doc_error(info: dict) -> bool:
    """True if a failed bulk item is a 'document missing' error (corpusid not yet ingested)."""
    update = info.get("update", info) if isinstance(info, dict) else {}
    if update.get("status") == 404:
        return True
    err = update.get("error") or {}
    return isinstance(err, dict) and err.get("type") == "document_missing_exception"


def classify_bulk_result(ok: bool, info: dict) -> str:
    """Map a parallel_bulk result to 'ok' | 'missing' | 'error'."""
    if ok:
        return "ok"
    return "missing" if is_missing_doc_error(info) else "error"


# ---------------------------------------------------------------------------
# OpenSearch helpers
# ---------------------------------------------------------------------------

def ensure_abstract_source_field(os_client, index: str) -> None:
    """Additively add the `abstract_source` keyword mapping if the index lacks it (no reindex)."""
    if not os_client.indices.exists(index=index):
        logger.warning("index %r does not exist; nothing to update", index)
        return
    mapping = os_client.indices.get_mapping(index=index)
    props = next(iter(mapping.values()))["mappings"].get("properties", {})
    if "abstract_source" not in props:
        os_client.indices.put_mapping(
            index=index, body={"properties": {"abstract_source": {"type": "keyword"}}})
        logger.info("added abstract_source keyword mapping to %r", index)


def set_bulk_mode(os_client, index: str, on: bool) -> None:
    """Disable refresh during the push for throughput; restore to 1s afterwards."""
    settings = {"index": {"refresh_interval": "-1" if on else "1s"}}
    os_client.indices.put_settings(index=index, body=settings)


# ---------------------------------------------------------------------------
# Band processing
# ---------------------------------------------------------------------------

def _create_read_session(read_client, types, table_path: str, parent: str,
                         row_restriction: str, max_stream_count: int):
    read_options = types.ReadSession.TableReadOptions(selected_fields=_COLUMNS)
    if row_restriction:
        read_options.row_restriction = row_restriction
    requested = types.ReadSession(table=table_path, data_format=types.DataFormat.ARROW,
                                  read_options=read_options)
    return read_client.create_read_session(
        parent=parent, read_session=requested, max_stream_count=max_stream_count)


def process_band(*, os_client, read_client, types, helpers, table_path: str, parent: str,
                 restriction: str, index: str, chunk_size: int, index_threads: int,
                 max_docs: int | None) -> tuple[int, int, int, bool]:
    """Read one corpusid band of abstracts_openalex and push updates.

    Returns (updated_ok, missing, errors, truncated). `truncated` means cut short by max_docs
    (band not fully processed -> must not be checkpointed).
    """
    session = _create_read_session(read_client, types, table_path, parent, restriction,
                                   index_threads)
    streams = [s.name for s in session.streams]
    if not streams:
        return 0, 0, 0, False

    def action_gen():
        seen = 0
        for stream_name in streams:
            reader = read_client.read_rows(stream_name)
            for page in reader.rows(session).pages:
                for row in page.to_arrow().to_pylist():
                    abstract = row["abstract"]
                    if not abstract:
                        continue
                    yield row_to_update_action(row["corpusid"], abstract,
                                               row["source"], index)
                    seen += 1
                    if max_docs is not None and seen >= max_docs:
                        return

    ok_n = missing = errors = 0
    truncated = False
    processed = 0
    for ok, info in helpers.parallel_bulk(
        os_client, action_gen(), thread_count=index_threads, chunk_size=chunk_size,
        queue_size=index_threads * 2, raise_on_error=False, raise_on_exception=False,
    ):
        kind = classify_bulk_result(ok, info)
        if kind == "ok":
            ok_n += 1
        elif kind == "missing":
            missing += 1
        else:
            errors += 1
            if errors <= 5:
                logger.warning("bulk update error: %s", info)
        processed += 1
        if max_docs is not None and processed >= max_docs:
            truncated = True
            break
    return ok_n, missing, errors, truncated


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index-threads", type=int, default=8)
    ap.add_argument("--chunk-size", type=int, default=2000)
    ap.add_argument("--max-docs", type=int, default=None, help="stop after N updates (sampling)")
    ap.add_argument("--band-width", type=int, default=2_000_000)
    ap.add_argument("--checkpoint", type=str, default=str(_DEFAULT_CHECKPOINT))
    ap.add_argument("--band-retries", type=int, default=5)
    args = ap.parse_args()

    from google.cloud import bigquery
    from google.cloud.bigquery_storage_v1 import BigQueryReadClient, types
    from opensearchpy import OpenSearch, helpers

    dataset = os.environ["BIGQUERY_DATASET_REF"]
    index = os.getenv("OPENSEARCH_INDEX", "papers")
    # Changed default protocol to https:// for the dockerised OpenSearch.
    os_url = os.getenv("OPENSEARCH_URL", "https://localhost:9200")

    bq = bigquery.Client()
    ds_project, dataset_id = dataset.split(".", 1) if "." in dataset else (bq.project, dataset)
    table_fq = f"{ds_project}.{dataset_id}.{_BACKFILL_TABLE}"
    table_path = f"projects/{ds_project}/datasets/{dataset_id}/tables/{_BACKFILL_TABLE}"
    parent = f"projects/{bq.project}"

    # --- OpenSearch client (prod: self-signed TLS + basic auth) ---
    os_client = OpenSearch(
        hosts=[os_url],
        http_auth=("admin", "admin"),  # Default OpenSearch credentials; change if you set a custom one
        use_ssl=os_url.startswith("https"),
        verify_certs=False,            # Tells the client to ignore the self-signed TLS cert from Docker
        ssl_show_warn=False,           # Suppresses Unverified HTTPS connection warnings
        maxsize=args.index_threads,
        timeout=120,
        max_retries=3,
        retry_on_timeout=True,
    )
    ensure_abstract_source_field(os_client, index)

    row = list(bq.query(f"SELECT MAX(corpusid) AS m FROM `{table_fq}`").result())[0]
    corpusid_max = int(row["m"] or 0)
    if corpusid_max == 0:
        logger.info("abstracts_openalex is empty; nothing to push")
        return
    bands = compute_bands(corpusid_max, args.band_width)
    ckpt = Checkpoint.load_or_init(args.checkpoint, args.band_width, corpusid_max)
    remaining = ckpt.remaining(bands)
    logger.info("bands: %d total | %d done | %d to process (band width %d)",
                len(bands), ckpt.completed_count, len(remaining), args.band_width)

    read_client = BigQueryReadClient()
    transient = _transient_exceptions()
    set_bulk_mode(os_client, index, on=True)

    g_ok = g_missing = g_err = 0
    budget = args.max_docs
    t0 = time.time()
    try:
        for b in remaining:
            restriction = f"corpusid >= {b.lo} AND corpusid < {b.hi}"
            logger.info("band %d/%d  corpusid [%d, %d)", b.index, bands[-1].index, b.lo, b.hi)

            def _run(b=b, restriction=restriction, budget=budget):
                return process_band(
                    os_client=os_client, read_client=read_client, types=types, helpers=helpers,
                    table_path=table_path, parent=parent, restriction=restriction, index=index,
                    chunk_size=args.chunk_size, index_threads=args.index_threads, max_docs=budget)

            ok_n, missing, errors, truncated = with_retries(
                _run, attempts=args.band_retries, base_delay=2.0, max_delay=60.0,
                exceptions=transient)
            g_ok += ok_n
            g_missing += missing
            g_err += errors
            if truncated:
                logger.info("--max-docs reached mid-band %d; stopping (band not checkpointed)",
                            b.index)
                break
            ckpt.mark_done(b.index)
            logger.info("band %d done (+%d updated, %d missing, %d err) | %d/%d bands",
                        b.index, ok_n, missing, errors, ckpt.completed_count, len(bands))
            if budget is not None:
                budget -= (ok_n + missing + errors)
                if budget <= 0:
                    logger.info("--max-docs reached; stopping (checkpoint preserved)")
                    break
    finally:
        set_bulk_mode(os_client, index, on=False)
        os_client.indices.refresh(index=index)
        logger.info("done: %d updated, %d missing (_id not ingested), %d errors in %.1fs; %d/%d bands",
                    g_ok, g_missing, g_err, time.time() - t0, ckpt.completed_count, len(bands))


def _transient_exceptions() -> tuple[type[BaseException], ...]:
    exc: list[type[BaseException]] = [ConnectionError, TimeoutError, OSError]
    try:
        from google.api_core import exceptions as gexc
        exc += [gexc.ServerError, gexc.TooManyRequests, gexc.ServiceUnavailable,
                gexc.DeadlineExceeded, gexc.GatewayTimeout, gexc.Aborted, gexc.RetryError]
    except Exception:  # noqa: BLE001
        pass
    try:
        from opensearchpy.exceptions import ConnectionError as OSConnErr, ConnectionTimeout
        exc += [OSConnErr, ConnectionTimeout]
    except Exception:  # noqa: BLE001
        pass
    return tuple(dict.fromkeys(exc))


if __name__ == "__main__":
    main()
