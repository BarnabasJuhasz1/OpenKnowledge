# Citation graph on hosted data — 01: BigQuery edge tables

## Problem
The citation-graph builder calls the **public** Semantic Scholar API and gets 429-rate-limited,
producing empty graphs (the "404 / no papers found"). We must build graphs from hosted data only.

Findings:
- OpenSearch `papers` index + BigQuery `papers_search`: node metadata only (keyed by integer
  `corpusid`); **no citation edges** (only `citationcount`/`referencecount` numbers).
- BigQuery `citations_raw_staging`: the **real** edges — 5.69B rows / 1.38 TB of raw JSON in a
  single `raw_line STRING` column, e.g.
  `{"citationid":...,"citingcorpusid":80185372,"citedcorpusid":13937359,"isinfluential":false,...}`.
  IDs are integer **corpusids** — they line up with OpenSearch.
- BigQuery `citations` (parsed): **broken / all NULL** — parsed with the wrong column names
  (`citingPaperId` vs `citingcorpusid`). Unusable.

## Goal
Build clustered, cheap-to-query edge tables from `citations_raw_staging`, for **both** traversal
directions (decision: build both directions; see plan 02 for how they are queried).

## Design
Cluster pruning only works on the **leading** cluster column, so each direction needs its own
clustering:
- `citation_edges`           CLUSTER BY `citingcorpusid` — for **references** (past: rows where the
  seed is the *citing* paper).
- `citation_edges_by_cited`  CLUSTER BY `citedcorpusid`  — for **citations** (future: rows where the
  seed is the *cited* paper).

Schema (both): `citingcorpusid INT64, citedcorpusid INT64, isinfluential BOOL`.

### Build (parse once, then two cheap clustered CTAS)
```sql
-- 1) Parse the 1.38 TB raw JSON once into a clustered base table (references direction).
CREATE TABLE `openknowledge-498014.semantic_scholar.citation_edges`
CLUSTER BY citingcorpusid AS
SELECT
  CAST(JSON_VALUE(raw_line, '$.citingcorpusid') AS INT64) AS citingcorpusid,
  CAST(JSON_VALUE(raw_line, '$.citedcorpusid')  AS INT64) AS citedcorpusid,
  CAST(JSON_VALUE(raw_line, '$.isinfluential')  AS BOOL)  AS isinfluential
FROM `openknowledge-498014.semantic_scholar.citations_raw_staging`
WHERE raw_line IS NOT NULL
  AND JSON_VALUE(raw_line, '$.citingcorpusid') IS NOT NULL
  AND JSON_VALUE(raw_line, '$.citedcorpusid')  IS NOT NULL;

-- 2) Reverse-clustered copy for the citations direction (reads the ~140 GB table, not the 1.38 TB raw).
CREATE TABLE `openknowledge-498014.semantic_scholar.citation_edges_by_cited`
CLUSTER BY citedcorpusid AS
SELECT citingcorpusid, citedcorpusid, isinfluential
FROM `openknowledge-498014.semantic_scholar.citation_edges`;
```

### Cost / safety
- Step 1 scans `raw_line` ≈ **1.38 TB** (~$7–9 on-demand). Step 2 scans the parsed table
  ≈ **~140 GB** (~$1). Storage ≈ ~140 GB per table (~$3/mo each).
- **Billable + consequential** → run a `--dry_run` first, print `totalBytesProcessed`, show the SQL,
  and get explicit confirmation before executing (per CLAUDE.md risky-command rule).
- Idempotent-ish: use `CREATE TABLE` (not OR REPLACE) so a re-run errors instead of silently
  re-billing; drop explicitly if a rebuild is intended.

## Verify
- `SELECT COUNT(*)` on both tables ≈ 5.69B (minus null/dupe drops).
- Spot-check a known corpusid: `SELECT citedcorpusid FROM citation_edges WHERE citingcorpusid=@x LIMIT 5`
  bills only a few MB (cluster pruning), not 1.38 TB.

## Done when
Both tables exist, counts are sane, and a single-corpusid lookup in each direction bills < ~100 MB.
```
