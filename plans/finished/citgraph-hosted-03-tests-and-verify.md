# Citation graph on hosted data — 03: tests & verification

## Unit tests (run in `research` conda env, `-m "not live"`)

### `tests/unit/test_bigquery_citations.py` (new)
- `is_configured` true/false from env.
- `references`/`citations` build the right SQL + params (monkeypatch the bigquery client to capture
  the query string + `query_parameters`, return canned rows); assert table name, `IN UNNEST(@ids)`,
  `QUALIFY ... <= @cap`, and the (citing, cited) tuples returned.
- not-configured → `BigQueryNotConfiguredError`; client error → `BigQueryCitationsError`.

### `tests/unit/test_opensearch_engine.py` (extend)
- `resolve_corpusids`: integer seed passes through; DOI/arXiv seed resolved via terms query
  (monkeypatch `_FakeClient.search`); title seed via match; unresolved seed omitted.
- `fetch_nodes_by_corpusid`: terms query, chunking > batch size, maps hits → `Paper` by corpusid.

### `tests/unit/test_citgraph_builder.py` (rewrite — drop all httpx/API tests)
Monkeypatch the OpenSearch engine (resolve + hydrate) and the BigQuery edge client.
- k=1 `build`: seed + a reference + a citer; assert nodes `{seed, ref, citer}` and edge directions
  (`(seed, ref)`, `(citer, seed)`).
- `explore` direction `past`/`future`/`both` pulls the right sources.
- Neighbor missing from OpenSearch → node and its edge dropped.
- `include_non_matching=false` keyword filter drops non-matching neighbors + their edges.
- No resolvable seed → empty result (→ API 404, unchanged).
- Backend error (BQ/OpenSearch) → `UpstreamError` (→ API 503, unchanged).

### `tests/unit/test_citgraph_enrichment.py`
Confirm still green (enrichment/`_to_response` path is unchanged); fix only if it referenced removed
API internals.

## Live verification (tunnel to GCP OpenSearch + real BigQuery)
After plan 01 tables exist:
- Resolve a known DOI seed → corpusid; build k=1 → assert non-empty nodes/edges, no network call to
  `api.semanticscholar.org` (grep logs; the old 429 lines must be gone).
- Confirm a single graph build bills only a few MB on BigQuery (cluster pruning).

## Done when
Full unit suite green; live k=1 build returns a real graph from hosted data with zero public-API
calls. Then move all three plan docs to `plans/finished/`.
```
