#!/usr/bin/env python
"""Bulk-load the BigQuery `papers_search` export into OpenSearch.

Reads `papers_search` (built by bigquery_setup.sql) through the **BigQuery Storage Read
API** — the server splits the table into N streams that are read in parallel (Arrow),
with no per-page query-job overhead — and indexes documents into OpenSearch via
`helpers.parallel_bulk` (M concurrent indexing threads). Reading and indexing overlap.

The doc `_id` is the corpusid, so the load is idempotent: re-running is safe and re-indexes
the same docs. Storage Read API streams are NOT ordered, so the load is checkpointed by
**corpusid bands** (see ingest_resume.py): the corpusid space is split into fixed-width
half-open ranges, processed sequentially with a server-side `row_restriction`, and each band
is recorded as done only once fully indexed. A crash resumes at the first unfinished band
instead of redoing everything. `--resume-from` is kept as a legacy lower bound.

Usage:
    python scripts/ingest_opensearch.py                       # full corpus (checkpointed)
    python scripts/ingest_opensearch.py --max-docs 5000       # sample (testing)
    python scripts/ingest_opensearch.py --reconcile           # mark already-full bands done first
    python scripts/ingest_opensearch.py --band-width 1000000  # finer checkpoint granularity
    python scripts/ingest_opensearch.py --read-streams 16 --index-threads 12

Env (from .env): BIGQUERY_DATASET_REF (project.dataset), BIGQUERY_SEARCH_TABLE,
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

from ingest_resume import Checkpoint, compute_bands, with_retries

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingest")

_INDEX_DEF = _BACKEND_ROOT / "scripts" / "opensearch_index.json"
_DEFAULT_CHECKPOINT = Path(__file__).resolve().parent / ".ingest_checkpoint.json"

# Columns pulled from papers_search (must match _row_to_doc below).
_COLUMNS = [
    "corpusid", "title", "abstract", "year", "publicationdate", "citationcount",
    "influentialcitationcount", "referencecount", "isopenaccess", "url", "venue",
    "journal", "authors", "externalids", "s2fieldsofstudy", "publicationtypes",
]

_SENTINEL = object()


def _transient_exceptions() -> tuple[type[BaseException], ...]:
    """Errors worth retrying a band for: network / transient BigQuery / OpenSearch faults."""
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


def _band_restriction(lo: int, hi: int, resume_from: int) -> str:
    """`row_restriction` for a band, honouring the legacy `--resume-from` lower bound."""
    lower = max(lo, resume_from + 1) if resume_from > 0 else lo
    return f"corpusid >= {lower} AND corpusid < {hi}"


def _create_read_session(read_client, types, table_path: str, parent: str,
                         row_restriction: str, max_stream_count: int):
    read_options = types.ReadSession.TableReadOptions(selected_fields=_COLUMNS)
    if row_restriction:
        read_options.row_restriction = row_restriction
    requested = types.ReadSession(
        table=table_path,
        data_format=types.DataFormat.ARROW,
        read_options=read_options,
    )
    return read_client.create_read_session(
        parent=parent, read_session=requested, max_stream_count=max_stream_count,
    )


def process_band(*, os_client, read_client, types, helpers, table_path: str, parent: str,
                 restriction: str, read_streams: int, index_threads: int, chunk_size: int,
                 index: str, max_docs: int | None) -> tuple[int, int, bool]:
    """Read+index one corpusid band. Returns (docs_indexed, errors, truncated).

    ``truncated`` is True when the band was cut short by ``max_docs`` (so it is NOT fully
    indexed and must not be checkpointed as done).

    Re-creates the read session, hand-off queue and threads on every call so a retry after a
    transient failure starts the band cleanly (idempotent ``_id`` makes the reprocess safe).
    If any reader stream raises, the band is incomplete — re-raise so the caller's retry
    logic re-runs the whole band rather than marking it done.
    """
    session = _create_read_session(read_client, types, table_path, parent,
                                   restriction, read_streams)
    streams = [s.name for s in session.streams]
    if not streams:
        return 0, 0, False  # empty range (no rows in this band)
    logger.info("  read session: %d stream(s); %d index thread(s)", len(streams), index_threads)

    doc_q: queue.Queue = queue.Queue(maxsize=chunk_size * index_threads * 4)
    stop_event = threading.Event()
    reader_exc: list[BaseException] = []

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
        while True:
            item = doc_q.get()
            if item is _SENTINEL:
                return
            yield item

    total = 0
    errors = 0
    truncated = False
    with ThreadPoolExecutor(max_workers=len(streams)) as pool:
        futures = {pool.submit(read_stream, s): s for s in streams}

        def close_when_done() -> None:
            for f in as_completed(futures):
                exc = f.exception()
                if exc is not None:
                    reader_exc.append(exc)
                    logger.error("reader stream failed: %s", exc)
            doc_q.put(_SENTINEL)

        threading.Thread(target=close_when_done, daemon=True).start()

        for ok, info in helpers.parallel_bulk(
            os_client, action_gen(),
            thread_count=index_threads, chunk_size=chunk_size,
            queue_size=index_threads * 2,
            raise_on_error=False, raise_on_exception=False,
        ):
            total += 1
            if not ok:
                errors += 1
                if errors <= 5:
                    logger.warning("bulk error: %s", info)
            if max_docs is not None and total >= max_docs:
                truncated = True
                stop_event.set()
                break

    # A failed reader means the band is not fully read — surface it so the band is retried,
    # not silently recorded as complete. (Don't raise when we deliberately stopped for max_docs.)
    if reader_exc and not truncated:
        raise reader_exc[0]
    return total, errors, truncated


def reconcile_existing(bq, os_client, table_fq: str, index: str, bands, band_width: int,
                       ckpt: Checkpoint) -> None:
    """Mark bands that are already fully indexed so a resumed run skips them.

    One BigQuery query buckets the corpus by band; each band's OpenSearch count in the same
    range is compared. Equal & non-zero ⇒ fully indexed (one doc per row, `_id` dedups), so it
    is marked done. A mismatch is conservative: the band is simply reprocessed (idempotent).
    """
    logger.info("reconcile: bucketing corpus by band in BigQuery ...")
    q = (f"SELECT DIV(corpusid, {band_width}) AS band, COUNT(*) AS n "
         f"FROM `{table_fq}` GROUP BY band")
    bq_counts = {int(r["band"]): int(r["n"]) for r in bq.query(q).result()}
    marked = 0
    for b in bands:
        if ckpt.is_done(b.index):
            continue
        bq_n = bq_counts.get(b.index, 0)
        if bq_n == 0:
            continue
        body = {"query": {"range": {"corpusid": {"gte": b.lo, "lt": b.hi}}}}
        os_n = os_client.count(index=index, body=body)["count"]
        if os_n == bq_n:
            ckpt.mark_done(b.index)
            marked += 1
    logger.info("reconcile: marked %d band(s) already fully indexed (now %d/%d done)",
                marked, ckpt.completed_count, len(bands))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--read-streams", type=int, default=8,
                    help="parallel BigQuery Storage read streams (server may return fewer)")
    ap.add_argument("--index-threads", type=int, default=8,
                    help="parallel OpenSearch bulk indexing threads")
    ap.add_argument("--chunk-size", type=int, default=5000, help="docs per bulk request")
    ap.add_argument("--max-docs", type=int, default=None, help="stop after N docs (sampling)")
    ap.add_argument("--resume-from", type=int, default=0,
                    help="legacy lower bound: skip corpusid <= this (superseded by checkpoint)")
    ap.add_argument("--band-width", type=int, default=2_000_000,
                    help="corpusid band width; the checkpoint unit (default 2,000,000)")
    ap.add_argument("--checkpoint", type=str, default=str(_DEFAULT_CHECKPOINT),
                    help="path to the resume checkpoint file")
    ap.add_argument("--band-retries", type=int, default=5,
                    help="attempts per band before stopping (transient errors back off)")
    ap.add_argument("--corpusid-max", type=int, default=0,
                    help="override the auto MAX(corpusid) probe")
    ap.add_argument("--reconcile", action="store_true",
                    help="mark already fully-indexed bands done before resuming")
    args = ap.parse_args()

    from google.cloud import bigquery
    from google.cloud.bigquery_storage_v1 import BigQueryReadClient, types
    from opensearchpy import OpenSearch, helpers

    dataset = os.environ["BIGQUERY_DATASET_REF"]
    table = os.getenv("BIGQUERY_SEARCH_TABLE", "papers_search")
    index = os.getenv("OPENSEARCH_INDEX", "papers")
    # Changed default protocol to https:// for the dockerised OpenSearch.
    os_url = os.getenv("OPENSEARCH_URL", "https://localhost:9200")

    bq = bigquery.Client()  # billing project / ADC resolution + corpus row count
    ds_project, dataset_id = dataset.split(".", 1) if "." in dataset else (bq.project, dataset)
    table_fq = f"{ds_project}.{dataset_id}.{table}"
    table_path = f"projects/{ds_project}/datasets/{dataset_id}/tables/{table}"
    parent = f"projects/{bq.project}"
    try:  # table metadata read — free, instant; gives the denominator for % progress
        total_rows = bq.get_table(table_fq).num_rows or 0
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not read corpus row count (%s); %% progress disabled", exc)
        total_rows = 0

    # Explicit security config for the local Docker environment (self-signed TLS).
    os_client = OpenSearch(
        hosts=[os_url],
        http_auth=("admin", "admin"),  # Default OpenSearch credentials; change if you set a custom one
        use_ssl=os_url.startswith("https"),
        verify_certs=False,            # Tells the client to ignore the self-signed TLS cert from Docker
        ssl_show_warn=False,           # Suppresses Unverified HTTPS connection warnings
        # Pool one connection per indexing thread so parallel_bulk reuses, not churns, them.
        maxsize=args.index_threads,
        # A bulk of large (abstract-bearing) docs easily exceeds the 10s default,
        # especially when OpenSearch shares CPU with this loader. Wait, and retry.
        timeout=120,
        max_retries=3,
        retry_on_timeout=True,
    )
    ensure_index(os_client, index)

    # corpusid_max: explicit override, else one cheap MAX() probe (drives band layout).
    corpusid_max = args.corpusid_max
    if corpusid_max <= 0:
        logger.info("probing MAX(corpusid) ...")
        row = list(bq.query(f"SELECT MAX(corpusid) AS m FROM `{table_fq}`").result())[0]
        corpusid_max = int(row["m"] or 0)
    bands = compute_bands(corpusid_max, args.band_width)
    ckpt = Checkpoint.load_or_init(args.checkpoint, args.band_width, corpusid_max)

    try:  # docs already indexed — informational baseline only (no longer the % source)
        baseline = os_client.count(index=index)["count"]
    except Exception:  # noqa: BLE001
        baseline = 0
    if total_rows:
        logger.info("corpus %d docs (max corpusid %d); %d already indexed (%.2f%%)",
                    total_rows, corpusid_max, baseline, 100.0 * baseline / total_rows)
    else:
        logger.info("%d docs already indexed (corpus size unknown)", baseline)

    if args.reconcile:
        reconcile_existing(bq, os_client, table_fq, index, bands, args.band_width, ckpt)

    remaining = [b for b in ckpt.remaining(bands)
                 if not (args.resume_from and b.hi <= args.resume_from + 1)]
    logger.info("bands: %d total | %d done | %d to process (band width %d)",
                len(bands), ckpt.completed_count, len(remaining), args.band_width)

    read_client = BigQueryReadClient()
    transient = _transient_exceptions()
    set_bulk_mode(os_client, index, on=True)

    grand_total = 0
    budget = args.max_docs
    t0 = time.time()
    last_band = bands[-1].index if bands else 0
    try:
        for b in remaining:
            restriction = _band_restriction(b.lo, b.hi, args.resume_from)
            logger.info("band %d/%d  corpusid [%d, %d)", b.index, last_band, b.lo, b.hi)

            def _run(b=b, restriction=restriction, budget=budget):
                return process_band(
                    os_client=os_client, read_client=read_client, types=types, helpers=helpers,
                    table_path=table_path, parent=parent, restriction=restriction,
                    read_streams=args.read_streams, index_threads=args.index_threads,
                    chunk_size=args.chunk_size, index=index, max_docs=budget,
                )

            try:
                total, errors, truncated = with_retries(
                    _run, attempts=args.band_retries, base_delay=2.0, max_delay=60.0,
                    exceptions=transient,
                )
            except Exception as exc:  # noqa: BLE001 — band failed all attempts
                logger.error("band %d failed after %d attempt(s): %s — stopping; "
                             "re-run to resume from this band", b.index, args.band_retries, exc)
                raise

            grand_total += total
            if truncated:
                # Cut short by --max-docs: band not fully indexed, so do NOT checkpoint it.
                logger.info("--max-docs reached mid-band %d; stopping "
                            "(band left incomplete, not checkpointed)", b.index)
                break
            ckpt.mark_done(b.index)
            try:
                idx_count = os_client.count(index=index)["count"]
            except Exception:  # noqa: BLE001
                idx_count = baseline + grand_total
            rate = grand_total / max(time.time() - t0, 1e-6)
            if total_rows:
                logger.info("band %d done (+%d, %d err) | %d/%d bands | index %d/%d (%.2f%%) | %.0f docs/s",
                            b.index, total, errors, ckpt.completed_count, len(bands),
                            idx_count, total_rows, 100.0 * idx_count / total_rows, rate)
            else:
                logger.info("band %d done (+%d, %d err) | %d/%d bands | index %d | %.0f docs/s",
                            b.index, total, errors, ckpt.completed_count, len(bands), idx_count, rate)

            if budget is not None:
                budget -= total
                if budget <= 0:
                    logger.info("--max-docs reached; stopping (checkpoint preserved)")
                    break
    finally:
        set_bulk_mode(os_client, index, on=False)
        os_client.indices.refresh(index=index)
        try:  # re-count after refresh for an accurate global figure
            final = os_client.count(index=index)["count"]
        except Exception:  # noqa: BLE001
            final = baseline + grand_total
        if total_rows:
            logger.info("done: +%d this run in %.1fs; index now %d/%d (%.2f%%); %d/%d bands done",
                        grand_total, time.time() - t0, final, total_rows,
                        100.0 * final / total_rows, ckpt.completed_count, len(bands))
        else:
            logger.info("done: +%d this run in %.1fs; index now %d docs; %d/%d bands done",
                        grand_total, time.time() - t0, final, ckpt.completed_count, len(bands))


if __name__ == "__main__":
    main()
