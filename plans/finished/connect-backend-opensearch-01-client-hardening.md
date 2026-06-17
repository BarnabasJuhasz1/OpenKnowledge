# Connect backend to live OpenSearch — 01: client hardening + health/count helpers

## Goal
Make `OpenSearchEngine` talk reliably to the live (mid-ingest, CPU-contended 2-vCPU)
node, and expose helpers so the caller can confirm connectivity and how many papers are
*currently searchable*.

## Why
The current client is `OpenSearch(hosts=[self.url])` — no timeout, no retry. Against a
node that is simultaneously running the bulk ingest, requests stall or fail intermittently
(same class of issue as the ingest loader's 10s default read-timeout). The endpoint already
wraps failures as 502/503, but the client itself must be resilient first.

## Changes (`app/services/retrieval/opensearch_search.py`)
1. Add env-configurable connection tuning, read in `__init__`:
   - `OPENSEARCH_TIMEOUT` (default `30` seconds)
   - `OPENSEARCH_MAX_RETRIES` (default `3`)
   - `OPENSEARCH_RETRY_ON_TIMEOUT` (default `true`)
   Add an `_env_bool` helper alongside `_env_int`.
2. Build the client with those kwargs:
   `OpenSearch(hosts=[url], timeout=..., max_retries=..., retry_on_timeout=...)`.
3. Add `ping() -> bool` — thin wrapper over `client.ping()`, so a caller / smoke test can
   verify the cluster is reachable without running a query.
4. Add `searchable_count() -> int` — `client.count(index)["count"]`, i.e. the number of
   documents that are refreshed and therefore *searchable right now* (directly answers
   "uses the currently searchable papers"). Wrap failures as `OpenSearchSearchError`.
5. Do NOT change `compile_to_opensearch` or the search body — boolean semantics were already
   verified correct (control=296, AND=89, OR=842, NOT=207 on the 5000-doc sample) and the
   match_phrase-in-(title OR abstract) mapping must stay stable.

## Tests (`tests/unit/test_opensearch_engine.py`)
- Assert the engine reads timeout/retry env (or constructor args) and that a built client
  receives them — inject a fake `OpenSearch` factory or assert on the stored attrs.
- `searchable_count()` returns the fake client's count; wraps errors as `OpenSearchSearchError`.
- `ping()` returns the fake client's ping result.
- Existing tests must still pass unchanged (they inject `_client` directly).

## Done when
`conda run -n research python -m pytest tests/unit -q -m "not live"` is green, including the
new assertions.
