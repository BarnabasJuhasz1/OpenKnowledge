# Fix: year-range slider bounds from full match set (not top-100 page)

## Problem
In Scholar mode the year-range filter's lower/upper bounds are derived from
`scoredPapers()` — the ~100-paper window the client holds — not the whole result
set. So the slider min/max reflect only the loaded page, the same class of bug
already fixed for field-of-study counts via the `/facets` aggregation.

## Approach
Reuse the existing whole-match-set facet aggregation (`field_facets` →
`POST /retrieval/scholar/facets`). Add `min`/`max` aggregations on `year`,
surface them in the response, and widen the sticky `observedYearRange` from them.

Why this is enough:
- `resetForNewSearch()` clears the year filter, so the first facets call after a
  new search sees the full match set → true full year range.
- `observedYearRange.update()` only ever widens, never shrinks. On a
  year-narrowing refetch the facets return narrowed bounds but the sticky range
  keeps the full span — so the slider can always be widened again.

## Subtasks
1. **Backend engine** (`opensearch_search.py`): add `year_min`/`year_max` `min`/`max`
   aggs to `field_facets`; return `year_min`/`year_max` (int | None).
2. **Backend model** (`paper.py`): add `year_min: int | None`, `year_max: int | None`
   to `ScholarFacetsResponse`.
3. **Frontend retrieval service**: add `year_min`/`year_max` to `ScholarFacetsResponse`.
4. **Frontend state**: extend `fieldFacets` signal type; add an effect that widens
   `observedYearRange` from facet year bounds.
5. **Tests**: backend engine + endpoint return year bounds; frontend state widens
   year range from facets without shrinking on narrowing.

## Test
- `conda run -n research python -m pytest tests/unit/test_opensearch_engine.py tests/unit/test_scholar_endpoint.py -q`
- `npx ng test --no-watch`
