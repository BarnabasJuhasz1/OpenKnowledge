# OpenAlex snapshot → BigQuery (abstract backfill, bulk path)

Operational runbook for the **workhorse** backfill path (subtask 02): load the OpenAlex
`works` snapshot into BigQuery, then run `openalex_extract_abstracts.sql` to reconstruct
abstracts and populate `semantic_scholar.abstracts_openalex` for the ~190M S2 papers that
ship with no abstract.

> ⚠️ **Cost / risk (CLAUDE.md "risky" class — confirm before running).**
> The snapshot is ~400 GB gzipped. The S3→GCS sync (egress + GCS storage), the `bq load`,
> and the landing-table scans all bill real money. **Pilot the API path (subtask 03) first**
> and read the subtask-06 go/no-go before running any of this. Drop the landing table when
> done to stop ongoing storage charges.

Prereqs: `gcloud`/`bq` authenticated (ADC), `aws` CLI (works with `--no-sign-request`),
a writable GCS bucket, and the `abstracts_openalex` sink + crosswalk views already created
(`abstract_backfill_setup.sql`, subtask 01).

Set these once:

```bash
export PROJECT=openknowledge-498014
export DATASET=semantic_scholar
export BUCKET=gs://<your-bucket>          # e.g. gs://ok-openalex-snapshot
export RELEASE=$(date +%F)                # record the snapshot release date you pulled
```

---

## 1. Sync the `works` prefix of the snapshot to GCS

OpenAlex publishes a free, requester-pays-free S3 mirror. We only need `data/works/`.

```bash
# ~400 GB. Run on a VM in the same region as the bucket to avoid egress surprises.
aws s3 sync --no-sign-request \
  s3://openalex/data/works/ ./openalex_works/ \
  --exclude "*" --include "updated_date=*/part_*.gz"

gsutil -m rsync -r ./openalex_works/ "$BUCKET/openalex/works/"
```

Alternative (no local disk): if the GCS mirror is available to you, `gsutil -m rsync` it
straight bucket-to-bucket. Either way, **record `$RELEASE`** — abstracts change between
snapshots and the provenance matters.

The snapshot layout is `data/works/updated_date=YYYY-MM-DD/part_000.gz …`; each `*.gz` is
gzipped JSON Lines, one `work` object per line. We only read a few fields:
`id`, `ids` (`doi`,`pmid`,`mag`), `abstract_inverted_index`.

---

## 2. `bq load` each gz JSONL into a raw landing table

Schema-proof, cheapest load: one `data STRING` column per line (no schema autodetect over
OpenAlex's huge nested shape). The CSV reader with a delimiter/quote that never appears in
the data turns each whole JSON line into one string cell.

```bash
# Create the landing table (single STRING column).
bq mk --table --force "$PROJECT:$DATASET.openalex_works_raw" data:STRING

# Load every partition. \x01 (SOH) and an empty quote disable CSV parsing so each line
# lands verbatim in `data`. allow_quoted_newlines is off — JSONL has none.
bq load \
  --source_format=CSV \
  --field_delimiter=$'\x01' \
  --quote='' \
  --max_bad_records=100000 \
  "$PROJECT:$DATASET.openalex_works_raw" \
  "$BUCKET/openalex/works/updated_date=*/part_*.gz" \
  data:STRING
```

`bq load` reads gzip natively (no manual decompress). `--max_bad_records` tolerates the rare
line that contains a `\x01`; check the load job's `badRecords` count afterwards and raise the
delimiter approach (e.g. a different control char) only if it is non-trivial.

Sanity check the landing table:

```bash
bq query --use_legacy_sql=false \
  "SELECT COUNT(*) AS rows,
          COUNTIF(JSON_QUERY(data,'\$.abstract_inverted_index') IS NOT NULL) AS with_inv_index
   FROM \`$PROJECT.$DATASET.openalex_works_raw\`"
```

---

## 3. Extract, match, populate (subtask 02 SQL)

Run the extraction script. It defines the inverted-index→plaintext UDF, builds the flattened
`openalex_abstracts_flat`, and MERGE-inserts gap-fill rows into `abstracts_openalex`
(idempotent — never double-inserts a corpusid, composes with the API path).

```bash
bq query --use_legacy_sql=false --format=none \
  < backend/scripts/openalex_extract_abstracts.sql
```

Verify (see the script's trailing comment block for exact queries): match rate, per-`match_key`
distribution, non-empty ratio, `COUNT(DISTINCT corpusid)`, and the gap-fill invariant
(no inserted corpusid already has a non-empty S2 abstract).

---

## 4. Cleanup (stop ongoing storage charges)

After `abstracts_openalex` is populated and verified:

```bash
bq rm -f -t "$PROJECT:$DATASET.openalex_works_raw"        # ~400 GB landing table
bq rm -f -t "$PROJECT:$DATASET.openalex_abstracts_flat"   # optional: keep for re-matching
gsutil -m rm -r "$BUCKET/openalex/works/"                 # the synced snapshot copy
```

Keep `openalex_abstracts_flat` only if you expect to re-run the match (e.g. after the
crosswalk widens to include arXiv); otherwise drop it too.

---

## Recommended: pilot one partition first

Before the full load, point step 2 at a **single** `part_*.gz` and run the whole chain
(load → extract → match) on it. Confirm the UDF output matches the OpenAlex API `abstract`
for a few sample ids, check the match rate and dedup, then commit to the full ~400 GB run.
This mirrors the subtask-06 pilot discipline at snapshot scale.
