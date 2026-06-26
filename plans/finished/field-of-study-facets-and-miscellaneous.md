# Field-of-study filter: real facet counts + Miscellaneous bucket

## Problem
On the retrieved-papers page the "Field of study" filter is broken in three ways:

1. **Counts come from the loaded page only.** In Scholar mode the client holds
   just one ~100-paper window, so `getFieldPaperCount()` (which counts
   `allScoredPapers()`) reflects that window, not the whole match set. The
   per-field counts are therefore tiny and **don't add up to the total number of
   papers**.
2. **No-field papers vanish from the tally.** Papers whose `fields_of_study` is
   empty aren't counted under any field, widening the gap between the field
   counts and the total. They should be grouped under **"Miscellaneous"**.
3. **Filtering is inconsistent / ineffective.**
   - The dropdown lists all 23 canonical fields regardless of whether the result
     set contains any — "too many fields of study".
   - There's no way to filter *for* no-field papers.
   - Client-side (demo) keeps no-field papers when a field subset is selected,
     but the Scholar server-side `terms` filter drops them — divergent behaviour.

The canonical Semantic Scholar taxonomy (the only fields S2 assigns) is already
encoded in `ALL_FIELDS_OF_STUDY` (23 entries) and the index stores exactly those
`s2fieldsofstudy.category` values (keyword type) — so the values match and the
term filter itself is sound. The fix is about **counts, the Miscellaneous
bucket, and showing only relevant fields**.

## Desired behaviour
- Per-field counts reflect the **whole filtered match set** (from the backend),
  not just the loaded page.
- Papers with no field of study are counted and filterable under
  **"Miscellaneous"**.
- The dropdown shows only fields that actually have papers in the current result
  set (plus Miscellaneous when non-empty), so the list is no longer cluttered.
- Selecting a field subset filters correctly server-side AND client-side,
  including the Miscellaneous (no-field) case, and the counts shown match what
  filtering returns.

> Note on "adding up": a paper may carry more than one S2 field, so membership
> counts can overlap and the per-field counts need not sum *exactly* to the
> total. The dominant gap the user saw — no-field papers and page-only counts —
> is closed by the Miscellaneous bucket + whole-match-set facets.

## Subtasks

### 1. Backend: field-of-study facet aggregation
File: `backend/app/services/retrieval/opensearch_search.py`
- Add `OpenSearchEngine.field_facets(boolean_query, *, filters) -> dict` that runs
  a `size: 0` search with:
  - `terms` agg on `fields_of_study` (size 30, covers the 23 canonical fields),
  - `missing` agg on `fields_of_study` → the Miscellaneous count,
  - `track_total_hits: true` for the total.
  Apply `_build_filters(filters)` so other active filters (year, citation, OA,
  peer-review) are reflected, but the **caller passes filters with
  `fields_of_study=None`** so toggling fields doesn't remove options from the
  list. Returns `{"fields": {name: count}, "miscellaneous": N, "total": T}`.

### 2. Backend: Miscellaneous-aware field filter
File: `backend/app/services/retrieval/opensearch_search.py` (`_build_filters`)
- The sentinel `"Miscellaneous"` in `fields_of_study` means "no field". Build:
  - real fields only → `terms` (unchanged),
  - Miscellaneous only → `must_not exists fields_of_study`,
  - both → `bool.should: [terms(real), must_not-exists]`, `minimum_should_match:1`.

### 3. Backend: facets endpoint
File: `backend/app/api/scholar.py`
- `POST /retrieval/scholar/facets` taking `ScholarPageRequest`, calling
  `engine.field_facets(...)` with the request's filters minus `fields_of_study`.
  Returns a `ScholarFacetsResponse` (new model in `models/paper.py`).

### 4. Frontend: fetch + store facets
Files: `frontend/src/app/core/services/retrieval.service.ts`,
`frontend/src/app/core/services/search-state.service.ts`,
`frontend/src/app/features/results/results.component.ts`
- `retrieval.scholarFieldFacets(...)` → `{fields, miscellaneous, total}`.
- `state.fieldFacets` signal; add `MISC_FIELD = 'Miscellaneous'` to the
  selectable set and to `selectedFields` defaults / all-selected logic.
- Fetch facets when a Scholar page loads / filters change (reuse the refetch
  debounce); send `fields_of_study` (incl. the Miscellaneous sentinel) in the
  page + classify filter payloads.

### 5. Frontend: dropdown shows real counts, only non-empty fields, + Miscellaneous
Files: `filters-sidebar.component.{ts,html}`
- `getFieldPaperCount()` reads `state.fieldFacets()`.
- Render only fields with count > 0 (fall back to the full list before facets
  load), then a Miscellaneous row when its count > 0.
- Summary / all-selected / reset account for Miscellaneous.

### 6. Frontend: consistent client-side filtering (demo mode)
File: `search-state.service.ts` (`filteredPapers`)
- When a field subset is active: a no-field paper is kept **iff** Miscellaneous
  is selected; a paper with fields is kept iff any of its fields is selected.

### 7. Tests
- Backend: `tests/unit/test_opensearch_query.py` — `_build_filters` for real /
  misc / both; `field_facets` body shape. `tests/unit/test_scholar_endpoint.py`
  — `/facets` happy path (mocked engine).
- Frontend: `search-state.service.spec.ts` — field + Miscellaneous client filter.

## Test plan
- `cd backend && conda run -n research pytest tests/unit -k "scholar or opensearch_query or facet"`
- `cd frontend && npx vitest run --silent` (or the field/state spec)
- `npx ng build --configuration development` to confirm it compiles.
