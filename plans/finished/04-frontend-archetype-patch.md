# Subtask 04 — Frontend: receive streamed archetypes & patch papers

## retrieval.service.ts (`searchStream`)
- The stream now emits a final `event: archetypes` with
  `data: {"archetypes": {paperKey: [primary, second]}}` before `done`.
- The current parser ignores `event:` lines and keys off payload shape. Add a
  branch: if `'archetypes' in parsed` → `subscriber.next({ type: 'archetypes',
  data: parsed.archetypes })`. Extend the emitted union type accordingly.

## search-state.service.ts
- Add `applyArchetypes(map: Record<string, [string | null, string | null]>)`:
  iterate `rawPapersBySource`, for each paper compute `paperId(p)`, and if the map
  has an entry, set `predicted_main_archetype` / `predicted_second_tier_archetype`.
  Replace the signal value immutably so computed views recompute.

## results.component.ts
- In the live-search stream subscriber `next`, handle
  `event.type === 'archetypes'` → `this.state.applyArchetypes(event.data)`.
- Background flow: background papers arrive already classified from the backend,
  so no extra frontend work — but ensure the `Paper` model passes the fields
  through (it already has them).

## Clustering tab
- `CitGraphService` node type already has the archetype fields and the real
  `/citgraph/build` now returns them — no change needed beyond backend.

## Test
- `ng build` (production) succeeds.
- Manual: live search with demo OFF shows archetype chips populating shortly after
  results; clustering graph nodes show archetype icons.
