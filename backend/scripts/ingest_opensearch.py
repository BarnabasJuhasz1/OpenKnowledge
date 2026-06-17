#!/usr/bin/env python
"""Bulk-load the BigQuery `papers_search` export into OpenSearch.

Reads `papers_search` (built by bigquery_setup.sql) through the **BigQuery Storage Read
API** — the server splits the table into N streams that are read in parallel (Arrow),
with no per-page query-job overhead — and indexes documents into OpenSearch via
`helpers.parallel_bulk` (M concurrent indexing threads). Reading and indexing overlap.

The doc `_id` is the corpusid, so the load is idempotent: re-running is safe and re-indexes
the same docs. Storage Read API streams are NOT ordered, so resuming is done with a
`row_restriction` on corpusid rather than an ordered cursor — pass `--resume-from <corpusid>`
with a value you know is fully done (or just re-run; idempotent `_id` makes overlap harmless).

This is the dev copy (docker-compose OpenSearch, security plugin disabled -> plain HTTP).
The production loader is deploy/opensearch-ingest/scripts/ingest_opensearch.py.

Usage:
    python scripts/ingest_opensearch.py                       # full corpus
    python scripts/ingest_opensearch.py --max-docs 5000       # sample (testing)
    python scripts/ingest_opensearch.py --resume-from 123456789
    python scripts/ingest_opensearch.py --read-streams 16 --index-threads 12

Env (from backend/.env): BIGQUERY_DATASET_REF (project.dataset), BIGQUERY_SEARCH_TABLE,
GOOGLE_APPLICATION_CREDENTIALS, OPENSEARCH_URL, OPENSEARCH_INDEX.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingest")

_INDEX_DEF = _BACKEND_ROOT / "scripts" / "opensearch_index.json"

# Columns pulled from papers_search (must match _row_to_doc below).
_COLUMNS = [
    "corpusid", "title", "abstract", "year", "publicationdate", "citationcount",
    "influentialcitationcount", "referencecount", "isopenaccess", "url", "venue",
    "journal", "authors", "externalids", "s2fieldsofstudy", "publicationtypes",
]

_SENTINEL = object()


def _row_to_doc(row) -> dict:
    """Map a papers_search row (plain dict from Arrow) to an OpenSearch document."""
    ext = dict(row["externalids"]) if row["externalids"] else {}
    journal = dict(row["journal"]) if row["journal"] else {}
    authors = [dict(a).get("name") for a in (row["authors"] or [])]
    authors = [n for n in authors if n]
    fields = []
    for f in (row["s2fieldsofstudy"] or []):
        cat = dict(f).get("category")
        if cat and cat not in fields:
            fields.append(cat)
    pub_date = row["publicationdate"]
    return {
        "_id": row["corpusid"],
        "corpusid": row["corpusid"],
        "title": row["title"],
        "abstract": row["abstract"],
        "year": row["year"],
        "publicationdate": pub_date.isoformat() if pub_date else None,
        "citationcount": row["citationcount"],
        "influentialcitationcount": row["influentialcitationcount"],
        "referencecount": row["referencecount"],
        "is_open_access": bool(row["isopenaccess"]) if row["isopenaccess"] is not None else False,
        "url": row["url"],
        "venue": row["venue"],
        "journal": journal.get("name"),
        "authors": authors,
        "doi": ext.get("DOI"),
        "arxiv_id": ext.get("ArXiv"),
        "pubmed_id": ext.get("PubMed"),
        "fields_of_study": fields,
        "publication_types": list(row["publicationtypes"] or []),
    }


def ensure_index(os_client, index: str) -> None:
    if os_client.indices.exists(index=index):
        logger.info("index %r already exists", index)
        return
    body = json.loads(_INDEX_DEF.read_text())
    os_client.indices.create(index=index, body=body)
    logger.info("created index %r", index)


def set_bulk_mode(os_client, index: str, on: bool) -> None:
    """Disable refresh during load for throughput; restore afterwards."""
    settings = {"index": {"refresh_interval": "-1" if on else "1s"}}
    os_client.indices.put_settings(index=index, body=settings)


def _progress_msg(total: int, errors: int, baseline: int, total_rows: int, t0: float) -> str:
    """Global progress line: `baseline` (docs already indexed at startup) + this run.

    `baseline` makes the global counter survive stop/resume — on restart it is re-read
    from the live index, so progress continues from the true indexed count.
    """
    rate = total / max(time.time() - t0, 1e-6)
    done = baseline + max(total - errors, 0)
    if total_rows:
        return ("indexed %d this run | global %d/%d (%.2f%%) | %.0f docs/s | %d errors"
                % (total, done, total_rows, 100.0 * done / total_rows, rate, errors))
    return ("indexed %d this run | global %d | %.0f docs/s | %d errors"
            % (total, done, rate, errors))


def _create_read_session(read_client, types, table_path: str, parent: str,
                         resume_from: int, max_stream_count: int):
    read_options = types.ReadSession.TableReadOptions(selected_fields=_COLUMNS)
    if resume_from > 0:
        read_options.row_restriction = f"corpusid > {resume_from}"
    requested = types.ReadSession(
        table=table_path,
        data_format=types.DataFormat.ARROW,
        read_options=read_options,
    )
    return read_client.create_read_session(
        parent=parent, read_session=requested, max_stream_count=max_stream_count,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--read-streams", type=int, default=8,
                    help="parallel BigQuery Storage read streams (server may return fewer)")
    ap.add_argument("--index-threads", type=int, default=8,
                    help="parallel OpenSearch bulk indexing threads")
    ap.add_argument("--chunk-size", type=int, default=5000, help="docs per bulk request")
    ap.add_argument("--max-docs", type=int, default=None, help="stop after N docs (sampling)")
    ap.add_argument("--resume-from", type=int, default=0,
                    help="only read corpusid > this (resume / idempotent overlap)")
    args = ap.parse_args()

    from google.cloud import bigquery
    from google.cloud.bigquery_storage_v1 import BigQueryReadClient, types
    from opensearchpy import OpenSearch, helpers

    dataset = os.environ["BIGQUERY_DATASET_REF"]
    table = os.getenv("BIGQUERY_SEARCH_TABLE", "papers_search")
    index = os.getenv("OPENSEARCH_INDEX", "papers")
    os_url = os.getenv("OPENSEARCH_URL", "http://localhost:9200")

    bq = bigquery.Client()  # billing project / ADC resolution + corpus row count
    ds_project, dataset_id = dataset.split(".", 1) if "." in dataset else (bq.project, dataset)
    table_path = f"projects/{ds_project}/datasets/{dataset_id}/tables/{table}"
    parent = f"projects/{bq.project}"
    try:  # table metadata read — free, instant; gives the denominator for % progress
        total_rows = bq.get_table(f"{ds_project}.{dataset_id}.{table}").num_rows or 0
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not read corpus row count (%s); %% progress disabled", exc)
        total_rows = 0

    # Pool one connection per indexing thread so parallel_bulk reuses, not churns, them.
    # timeout/retry: a bulk of large docs easily exceeds the 10s default under CPU contention.
    os_client = OpenSearch(
        hosts=[os_url], maxsize=args.index_threads,
        timeout=120, max_retries=3, retry_on_timeout=True,
    )
    ensure_index(os_client, index)
    try:  # docs already indexed by prior runs — the global-progress baseline
        baseline = os_client.count(index=index)["count"]
    except Exception:  # noqa: BLE001
        baseline = 0
    if total_rows:
        logger.info("corpus %d docs; %d already indexed (%.2f%%)",
                    total_rows, baseline, 100.0 * baseline / total_rows)
    else:
        logger.info("%d docs already indexed (corpus size unknown)", baseline)
    set_bulk_mode(os_client, index, on=True)

    read_client = BigQueryReadClient()
    session = _create_read_session(read_client, types, table_path, parent,
                                   args.resume_from, args.read_streams)
    streams = [s.name for s in session.streams]
    logger.info("read session: %d stream(s); indexing with %d thread(s)",
                len(streams), args.index_threads)

    # Bounded hand-off queue: reader threads -> parallel_bulk consumer.
    doc_q: queue.Queue = queue.Queue(maxsize=args.chunk_size * args.index_threads * 4)
    stop_event = threading.Event()

    def read_stream(stream_name: str) -> int:
        reader = read_client.read_rows(stream_name)
        n = 0
        for page in reader.rows(session).pages:
            if stop_event.is_set():
                break
            for row in page.to_arrow().to_pylist():
                action = {"_index": index, **_row_to_doc(row)}
                while not stop_event.is_set():
                    try:
                        doc_q.put(action, timeout=0.5)
                        break
                    except queue.Full:
                        continue
                else:
                    return n
                n += 1
        return n

    def action_gen():
        """Drain the queue until all readers are done (SENTINEL)."""
        while True:
            item = doc_q.get()
            if item is _SENTINEL:
                return
            yield item

    total = 0
    errors = 0
    t0 = time.time()
    try:
        if not streams:
            logger.info("no streams (empty table or row_restriction matched nothing)")
            return

        with ThreadPoolExecutor(max_workers=len(streams)) as pool:
            futures = {pool.submit(read_stream, s): s for s in streams}

            def close_when_done() -> None:
                for f in as_completed(futures):
                    exc = f.exception()
                    if exc is not None:
                        logger.error("reader stream failed: %s", exc)
                doc_q.put(_SENTINEL)

            threading.Thread(target=close_when_done, daemon=True).start()

            for ok, info in helpers.parallel_bulk(
                os_client, action_gen(),
                thread_count=args.index_threads, chunk_size=args.chunk_size,
                queue_size=args.index_threads * 2,
                raise_on_error=False, raise_on_exception=False,
            ):
                total += 1
                if not ok:
                    errors += 1
                    if errors <= 5:
                        logger.warning("bulk error: %s", info)
                if total % 50_000 == 0:
                    logger.info(_progress_msg(total, errors, baseline, total_rows, t0))
                if args.max_docs is not None and total >= args.max_docs:
                    stop_event.set()
                    break
    finally:
        stop_event.set()
        set_bulk_mode(os_client, index, on=False)
        os_client.indices.refresh(index=index)
        try:  # re-count after refresh for an accurate global figure
            final = os_client.count(index=index)["count"]
        except Exception:  # noqa: BLE001
            final = baseline + max(total - errors, 0)
        if total_rows:
            logger.info("done: +%d this run in %.1fs (%d errors); index now %d/%d (%.2f%%)",
                        total, time.time() - t0, errors, final, total_rows,
                        100.0 * final / total_rows)
        else:
            logger.info("done: +%d this run in %.1fs (%d errors); index now %d docs",
                        total, time.time() - t0, errors, final)


if __name__ == "__main__":
    main()
