# Fix: Scholar results not globally ok-score ordered across pages

## Problem (reported bug #1)
The Scholar results list jumps in ok-score at every 100-result boundary (e.g. page 11,
results 101+, starts a fresh high-to-low ok-score run). The list is only *locally* sorted
within each fetched window, not globally.

### Root cause
A sort-key mismatch between server and client:

- **Server** `OpenSearchEngine._build_sort("relevancy")` sorts by raw `citationcount desc`
  — a *proxy* for ok-score. `search_page` pages that order with from/size.
- **Client** `SearchStateService.filteredPapers` fetches a 100-paper window
  (`SCHOLAR_PAGE_SIZE`) and re-sorts **only that window** by the real ok-score
  `log10(1+citations) + hasCode + isPeer + hasData + log10(1+stars)` (equal weights).

The windows are therefore *partitioned* by citationcount but *displayed* in ok-score order.
A paper just past a window boundary can have a higher ok-score than the last paper of the
previous window (its code/peer/data/stars bonuses outweigh a citation gap), so each new
window visibly jumps upward. Globally the order is wrong.

## Fix
Rank the **whole match set** on the server by the *true* ok-score, so windows partition in
ok-score order. Then the client's per-window re-sort (identical formula, identical fields)
is consistent across windows — no jumps.

Implement a `script_score` query for the `relevancy` sort that computes the exact ok-score
formula in painless and sorts by `_score`. All inputs are already mapped fields
(`citationcount`, `repo_stars`, `has_public_code`, `has_dataset`, `publication_types` →
peer-reviewed). Non-relevancy sorts (year/citations/title) keep the existing field sort.

Note: `script_score` sorted by `_score` uses the normal top-K scoring collector (same
machinery as BM25 relevance) — NOT the slow "script in the sort clause" path — so it scales
like any relevance query.

## Subtasks
1. **Engine** (`app/services/retrieval/opensearch_search.py`)
   - Add `_OK_SCORE_SCRIPT` painless source (guards missing fields via `.size() > 0`;
     peer-reviewed = any `publication_types` in {JournalArticle, Conference}; weights = 1.0).
   - Add a shared helper that, given the compiled query + filters + sort, returns
     `(query, sort_clauses)`: for `relevancy` wrap the bool query in `script_score` and sort
     by `[{_score: desc}, {corpusid: asc}]`; otherwise the existing bool query + `_build_sort`.
   - Use it in both `search_page` and `ranked_corpusids` (archetype path) so every paged read
     is globally ok-score ordered.

2. **Tests** (`tests/unit/test_opensearch_engine.py`)
   - `search_page(sort="relevancy")` emits a `script_score` query wrapping the bool query and
     sorts by `_score` then `corpusid`; the painless mentions citation/peer/code/data/stars.
   - `search_page(sort="year_desc")` keeps the plain bool query + field sort (no script_score).
   - Filters still applied (filter clauses present under the wrapped bool query).
   - `ranked_corpusids(sort="relevancy")` likewise wraps in script_score.
   - Existing tests still pass.

## Out of scope
- Frontend untouched: it already recomputes ok-score from the same fields, so once the server
  global order is correct the per-window re-sort agrees. (No client change needed.)
- Other reported bugs (filtering) tracked separately.

## Test command
`conda run -n research python -m pytest tests/unit/test_opensearch_engine.py tests/unit/test_scholar_endpoint.py -q`
