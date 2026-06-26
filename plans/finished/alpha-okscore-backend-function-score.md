# Alpha: replace ok-score Painless script with a native function_score

## Problem
`relevancy` (the default sort) wraps every match in a Painless `script_score`
(`_OK_SCORE_SCRIPT`). With `track_total_hits: True`, OpenSearch must execute the
script on **every** matching document to build the top-K heap, so broad queries
hang ("loops forever") instead of returning the first page in ~2s.

Three of the script's fields — `has_public_code`, `repo_stars`, `has_dataset` —
are **not backfilled** in the live index, so they contribute 0 anyway. The script
is effectively computing `log10(1+citationcount) + peer_bonus` at enormous cost.

## Decision
For the alpha, rank by `log10(1+citationcount) + peer` using a **native
`function_score`** (no Painless, no unmapped fields). This honors
"citationcount + publication_type", matches the frontend `computeOkScore`
formula exactly, and is far cheaper than per-doc Painless.

## Changes — `backend/app/services/retrieval/opensearch_search.py`
1. Delete the `_OK_SCORE_SCRIPT` constant and its comment block.
2. In `_paged_query_and_sort`, replace the `relevancy` `script_score` branch with:
   ```python
   query = {
       "function_score": {
           "query": base,
           "functions": [
               {"field_value_factor": {
                   "field": "citationcount", "modifier": "log1p", "missing": 0}},
               {"filter": {"terms": {"publication_types": self._PEER_REVIEWED_TYPES}},
                "weight": 1.0},
           ],
           "score_mode": "sum",
           "boost_mode": "replace",
       }
   }
   ```
   Keep the `[{"_score": desc}, {"corpusid": asc}]` sort (stable paging).
   - `field_value_factor` modifier `log1p` == `log10(1 + value)` (base-10), exactly
     mirroring the client. `missing: 0` → `log10(1)=0` for docs without the field.
   - `score_mode: sum` + `boost_mode: replace` → final `_score = log10(1+c) + (1 if peer)`,
     dropping the BM25 component.

## Changes — `backend/tests/unit/test_opensearch_engine.py`
- `_bool_query` helper: unwrap `function_score` instead of `script_score`.
- `test_search_page_relevancy_*`: assert the `function_score` shape
  (field_value_factor on `citationcount` with `log1p`, peer-types filter weight,
  `score_mode=sum`, `boost_mode=replace`), still sorted by `_score` then `corpusid`.
- `test_search_page_non_relevancy_uses_plain_field_sort`: also assert
  `"function_score" not in body["query"]`.
- `test_ranked_corpusids_relevancy_*`: assert `function_score` in body.

## Test
`cd backend && conda run -n research pytest tests/unit/test_opensearch_engine.py -q`
