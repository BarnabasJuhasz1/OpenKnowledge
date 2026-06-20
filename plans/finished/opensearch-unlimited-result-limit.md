# OpenSearch: unset OPENSEARCH_RESULT_LIMIT means unlimited (scalable to >1M)

## Goal
When `OPENSEARCH_RESULT_LIMIT` is empty/unset, the engine returns **all** matching papers,
not a capped set — and the retrieval must scale to result sets well over a million.

## The real constraint
A plain `client.search(size=N)` cannot return more than `index.max_result_window`
(default **10,000**); asking for more errors out. So "all results" cannot be done by
setting a huge `size`. The scalable mechanism is the **scroll/scan API**
(`opensearchpy.helpers.scan`), which streams the full match set in bounded batches and is
not subject to the result-window ceiling. Memory also matters: a 1M+ result set must not be
materialized all at once, so the engine exposes a lazy generator.

## Changes (`app/services/retrieval/opensearch_search.py`)
1. Resolve the limit with a sentinel so "not passed" (read env) is distinct from an explicit
   `None` (unlimited). Env resolution: empty/unset/non-positive/invalid -> `None` (unlimited);
   a positive int -> that int. (`result_limit` becomes `int | None`.)
2. Add `iter_search(boolean_query) -> Iterator[Paper]` as the scalable core:
   - **Fast path** (finite limit ≤ `_MAX_RESULT_WINDOW`): one `client.search(size=limit)`,
     preserving BM25 relevance ordering for top-N queries.
   - **Scan path** (limit is `None`, or finite but > window): `helpers.scan` with
     `preserve_order=False` (cheap `_doc` order, constant memory), stopping at the finite
     limit if one is set. Unlimited mode is intentionally unordered — sorting 1M+ by score
     across a scroll is prohibitively expensive and meaningless for a full export.
3. `search(...) -> list[Paper]` becomes `list(self.iter_search(...))` (compatibility for
   existing callers / small result sets).
4. Optional batch/scroll tuning via `OPENSEARCH_SCAN_BATCH` (default 2000) and
   `OPENSEARCH_SCROLL` (default "2m").

## Tests (`tests/unit/test_opensearch_engine.py`)
- Empty/unset env -> `result_limit is None`; positive int parsed; invalid/0 -> None.
- Finite small limit uses the `client.search` fast path with `size`.
- Unlimited uses `helpers.scan` (monkeypatched) and returns every yielded hit as a Paper.
- Finite limit > window uses scan and caps at the limit.
- Existing mapping/error tests pinned to the fast path with an explicit small limit.

## Endpoint caveat (flag, do not silently re-cap)
`/retrieval/scholar/search` materializes the list and runs `archetype.classify_papers` over
it, then serializes one `SearchResponse`. At 1M+ that is the next scaling wall (memory + a
huge JSON body + classification cost). The engine change makes retrieval itself scale; note
this clearly and offer a streaming/paginated endpoint as a follow-up rather than reverting
to a silent cap.

## Done when
Unit suite green; live check shows a query with >10k matches returns the full set via scan
(not truncated at 10k), matching `client.count`.
