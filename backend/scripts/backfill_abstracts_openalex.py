#!/usr/bin/env python
"""Driver: backfill missing abstracts from OpenAlex into BigQuery `abstracts_openalex`.

The runnable-now path (subtask 03). Reads a bounded batch of work from the BigQuery view
`semantic_scholar.papers_missing_abstract` (corpusids that lack an abstract but carry a
DOI/PMID/MAG), fetches abstracts from OpenAlex via the async adapter
(`app/services/retrieval/openalex_abstracts.py`), reconstructs plaintext, dedups to one
abstract per corpusid (longest wins, like the bulk path), and writes them to
`semantic_scholar.abstracts_openalex` with a staged-load + `MERGE ... WHEN NOT MATCHED`
(idempotent — never double-inserts a corpusid, composes with the bulk path).

This is a pilot/targeted tool: it validates the whole chain on a small, cheap sample before
the heavy snapshot run. Subtask 04 (MERGE into papers_search) and 05 (push to OpenSearch)
make the recovered abstracts searchable.

Usage:
    python scripts/backfill_abstracts_openalex.py --limit 1000 --dry-run   # fetch+print only
    python scripts/backfill_abstracts_openalex.py --limit 1000             # real write
    python scripts/backfill_abstracts_openalex.py --corpusid-min 0 --corpusid-max 2000000
    python scripts/backfill_abstracts_openalex.py --corpusids-file ids.txt

Env (backend/.env): BIGQUERY_DATASET_REF (project.dataset), OPENALEX_MAILTO/CONTACT_EMAIL,
optional OPENALEX_API_KEY, OPENALEX_BATCH_SIZE, OPENALEX_MAX_RPS, OPENALEX_CACHE_DIR.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_ROOT / ".env")
# Make the app package importable (adapter lives under app/services/retrieval).
sys.path.insert(0, str(_BACKEND_ROOT))

from app.services.retrieval.openalex_abstracts import (  # noqa: E402
    OpenAlexAbstractFetcher, _Candidate, pick_longest_per_corpusid,
)
from ingest_resume import with_retries  # noqa: E402  (same scripts/ dir)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_openalex")

_DEFAULT_CHECKPOINT = Path(__file__).resolve().parent / ".backfill_openalex_checkpoint.json"


# ---------------------------------------------------------------------------
# BigQuery I/O
# ---------------------------------------------------------------------------

def _dataset_ref() -> tuple[str, str, str]:
    """Return (project, dataset_id, fq_dataset) from BIGQUERY_DATASET_REF."""
    ref = os.environ["BIGQUERY_DATASET_REF"]
    project, dataset_id = ref.split(".", 1)
    return project, dataset_id, ref


def read_work_from_papers_search(bq, *, corpusid_min: int, corpusid_max: int,
                                 limit: int | None) -> list[dict]:
    """Cheap band-sourced read of gap candidates from `papers_search` (clustered by corpusid).

    `papers_search` was built from the same papers+S2 join, so its NULL/empty `abstract` rows
    are exactly the gaps `papers_missing_abstract` lists — but reading a corpusid BAND here is
    prunable by the cluster key (~MB, not the view's ~69 GB full join scan). Used for the cheap
    repeatable pilot. Requires a bounded [corpusid_min, corpusid_max] so the scan stays small.
    """
    _, _, ref = _dataset_ref()
    sql = f"""
      SELECT corpusid,
             LOWER(externalids.DOI)         AS doi,
             CAST(externalids.PubMed AS STRING) AS pmid,
             CAST(externalids.MAG AS STRING)    AS mag
      FROM `{ref}.papers_search`
      WHERE corpusid BETWEEN {int(corpusid_min)} AND {int(corpusid_max)}
        AND (abstract IS NULL OR LENGTH(TRIM(abstract)) = 0)
        AND (externalids.DOI IS NOT NULL OR externalids.PubMed IS NOT NULL
             OR externalids.MAG IS NOT NULL)
      ORDER BY corpusid
    """
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return [dict(r) for r in bq.query(sql).result()]


def read_work(bq, *, limit: int | None, corpusid_min: int, corpusid_max: int | None,
              corpusids: list[int] | None) -> list[dict]:
    """Read (corpusid, doi, pmid, mag) rows needing an abstract, ordered by corpusid."""
    from google.cloud import bigquery

    _, _, ref = _dataset_ref()
    where = ["corpusid >= @cmin"]
    params = [bigquery.ScalarQueryParameter("cmin", "INT64", corpusid_min)]
    if corpusid_max is not None:
        where.append("corpusid <= @cmax")
        params.append(bigquery.ScalarQueryParameter("cmax", "INT64", corpusid_max))
    if corpusids:
        where.append("corpusid IN UNNEST(@ids)")
        params.append(bigquery.ArrayQueryParameter("ids", "INT64", corpusids))
    sql = (f"SELECT corpusid, doi, pmid, mag FROM `{ref}.papers_missing_abstract` "
           f"WHERE {' AND '.join(where)} ORDER BY corpusid")
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    return [dict(r) for r in job.result()]


def write_candidates(bq, rows: list[dict]) -> int:
    """Stage rows then MERGE WHEN NOT MATCHED into abstracts_openalex. Returns inserted count."""
    from google.cloud import bigquery

    if not rows:
        return 0
    project, dataset_id, ref = _dataset_ref()
    stage = f"{ref}.abstracts_openalex_stage_{int(time.time())}_{os.getpid()}"
    schema = [
        bigquery.SchemaField("corpusid", "INT64", mode="REQUIRED"),
        bigquery.SchemaField("abstract", "STRING"),
        bigquery.SchemaField("source", "STRING"),
        bigquery.SchemaField("source_id", "STRING"),
        bigquery.SchemaField("match_key", "STRING"),
        bigquery.SchemaField("abstract_len", "INT64"),
        bigquery.SchemaField("fetched_at", "TIMESTAMP"),
    ]
    load_cfg = bigquery.LoadJobConfig(
        schema=schema, write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE)
    bq.load_table_from_json(rows, stage, job_config=load_cfg).result()
    try:
        merge = f"""
        MERGE `{ref}.abstracts_openalex` T
        USING `{stage}` S
        ON T.corpusid = S.corpusid
        WHEN NOT MATCHED THEN
          INSERT (corpusid, abstract, source, source_id, match_key, abstract_len, fetched_at)
          VALUES (S.corpusid, S.abstract, S.source, S.source_id, S.match_key,
                  S.abstract_len, S.fetched_at)
        """
        job = bq.query(merge)
        job.result()
        return job.num_dml_affected_rows or 0
    finally:
        bq.delete_table(stage, not_found_ok=True)


# ---------------------------------------------------------------------------
# Fetch orchestration
# ---------------------------------------------------------------------------

async def gather_candidates(fetcher: OpenAlexAbstractFetcher,
                            work: list[dict]) -> list[_Candidate]:
    """Fetch abstracts for every available id of every corpusid, return all candidates.

    Each corpusid is attempted on all of doi/pmid/mag it has; the per-corpusid dedup
    (longest wins) happens in pick_longest_per_corpusid, mirroring the bulk path.
    """
    from app.services.retrieval.openalex_abstracts import _NORMALIZERS

    # id (normalized) -> corpusids that carry it, per match_key.
    id_to_corpus: dict[str, dict[str, list[int]]] = {"doi": {}, "pmid": {}, "mag": {}}
    for row in work:
        for key in ("doi", "pmid", "mag"):
            raw = row.get(key)
            norm = _NORMALIZERS[key](raw) if raw is not None else None
            if norm:
                id_to_corpus[key].setdefault(norm, []).append(int(row["corpusid"]))

    fetch = {"doi": fetcher.fetch_by_dois, "pmid": fetcher.fetch_by_pmids,
             "mag": fetcher.fetch_by_mags}
    candidates: list[_Candidate] = []
    for key, mapping in id_to_corpus.items():
        if not mapping:
            continue
        found = await fetch[key](list(mapping.keys()))
        for norm_id, abs in found.items():
            for corpusid in mapping.get(norm_id, []):
                candidates.append(_Candidate(
                    corpusid=corpusid, abstract=abs.abstract,
                    source_id=abs.source_id, match_key=abs.match_key))
    return candidates


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_corpusids_file(path: str) -> list[int]:
    ids: list[int] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            ids.append(int(line))
    return ids


async def _run(args) -> None:
    from google.cloud import bigquery

    bq = bigquery.Client()
    corpusids = _load_corpusids_file(args.corpusids_file) if args.corpusids_file else None
    if args.from_papers_search:
        if args.corpusid_max is None:
            raise SystemExit("--from-papers-search requires --corpusid-max (bounded band)")
        work = with_retries(
            lambda: read_work_from_papers_search(
                bq, corpusid_min=args.corpusid_min, corpusid_max=args.corpusid_max,
                limit=args.limit),
            attempts=3, base_delay=2.0, max_delay=30.0, exceptions=(Exception,))
    else:
        work = with_retries(
            lambda: read_work(bq, limit=args.limit, corpusid_min=args.corpusid_min,
                              corpusid_max=args.corpusid_max, corpusids=corpusids),
            attempts=3, base_delay=2.0, max_delay=30.0, exceptions=(Exception,))
    logger.info("read %d corpusid(s) needing an abstract", len(work))
    if not work:
        return

    async with OpenAlexAbstractFetcher(batch_size=args.batch_size) as fetcher:
        candidates = await gather_candidates(fetcher, work)
    best = pick_longest_per_corpusid(candidates)
    logger.info("matched %d/%d corpusid(s) to an OpenAlex abstract (%.1f%%)",
                len(best), len(work), 100.0 * len(best) / max(len(work), 1))

    if args.dry_run:
        for c in list(best.values())[:10]:
            preview = c.abstract[:160].replace("\n", " ")
            logger.info("  corpusid=%d [%s] len=%d  %s…",
                        c.corpusid, c.match_key, c.abstract_len, preview)
        logger.info("dry-run: no rows written")
        return

    now = datetime.now(timezone.utc).isoformat()
    rows = [{
        "corpusid": c.corpusid, "abstract": c.abstract, "source": "openalex",
        "source_id": c.source_id, "match_key": c.match_key,
        "abstract_len": c.abstract_len, "fetched_at": now,
    } for c in best.values()]
    inserted = write_candidates(bq, rows)
    logger.info("wrote %d new row(s) into abstracts_openalex (%d already present, skipped)",
                inserted, len(rows) - inserted)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None, help="max corpusids to attempt")
    ap.add_argument("--corpusid-min", type=int, default=0, help="lower corpusid bound (resume)")
    ap.add_argument("--corpusid-max", type=int, default=None, help="upper corpusid bound")
    ap.add_argument("--corpusids-file", type=str, default=None,
                    help="newline-delimited corpusid list to target")
    ap.add_argument("--from-papers-search", action="store_true",
                    help="cheap pilot: source gap candidates from papers_search (clustered) "
                         "over a bounded corpusid band instead of the full papers_missing_abstract "
                         "view; requires --corpusid-max")
    ap.add_argument("--batch-size", type=int, default=None, help="OpenAlex ids per request (<=50)")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + reconstruct + print, no BigQuery writes")
    ap.add_argument("--checkpoint", type=str, default=str(_DEFAULT_CHECKPOINT),
                    help="(reserved) resume checkpoint path")
    args = ap.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
