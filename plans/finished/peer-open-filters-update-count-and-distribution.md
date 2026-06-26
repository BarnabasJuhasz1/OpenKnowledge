# Show-only "Peer reviewed" / "Open access" filters → count + distribution

## Reported symptom (brainstorm/prompt_queue.md)
> Show-only 'peer reviewed' and 'open-access' filters do not update the filter count
> above the retrieved number of papers, and do not update the archetype distribution either.

## Investigation outcome: already resolved by the server-side filter wiring
The two toggles are now applied **server-side across the whole match set**, the same way
year/citation/field-of-study filters are. Verified at every layer:

1. **Live OpenSearch index** (`abstract:learning`): the filter clauses really narrow the set.
   - baseline `_count` = 3,035,170
   - `+ {"term":{"is_open_access":true}}` = 989,318
   - `+ {"terms":{"publication_types":["JournalArticle","Conference"]}}` = 2,220,320

2. **Backend** — `ScholarPageRequest` parses `open_access_only` / `peer_reviewed_only`, and
   `OpenSearchEngine._build_filters` emits `{"term":{"is_open_access":true}}` /
   `{"terms":{"publication_types":[...]}}`. The fields exist in `scripts/opensearch_index.json`
   and are populated by `scripts/ingest_opensearch.py`.

3. **Backend HTTP** — `POST /api/retrieval/scholar/search/page` against the live index returns
   a different `total_found` per filter:
   - none = 4,688,327 · `open_access_only` = 1,133,692 · `peer_reviewed_only` = 2,788,623

4. **Frontend** — `peerReviewedOnly`/`openAccessOnly` setters call `updateFilter`, which mutates
   the shared `filters` signal. `ResultsComponent`'s `filters()` effect fires
   `scheduleScholarRefetch()` → `loadScholarPage(1, true)` (so `scholarTotal` ⇒ the "filtered to N"
   count), `startScholarClassify()` (so the distribution restarts over the filtered set) and
   `loadScholarFacets()`. `buildScholarFilters()` includes both booleans on every path
   (page fetch, classify stream, facets). These two booleans share the *exact* code path with
   the year/citation filters — there is no branch that treats them differently.

The brainstorm note describes the earlier behaviour, when these toggles only filtered the
loaded ~100-paper window client-side (`filteredPapers()` lines), leaving the server total and
the classify stream untouched — which is exactly "count + distribution don't update".

## Regression guard added
`frontend/src/app/features/results/results.component.spec.ts` — drives `ResultsComponent`
end-to-end with stubbed retrieval, toggles each filter, and asserts the page/classify/facets
refetch carries the filter AND that `scholarTotal` (count), `scholarUnfilteredTotal` (stable
"papers found"), and `scholarArchetypeCounts` (distribution) all update accordingly.

## Tests
- Frontend: `npx ng test --no-watch` → 13 files / 92 tests pass (+2 new).
- Backend filtering re-verified live (numbers above); no backend code change needed.
