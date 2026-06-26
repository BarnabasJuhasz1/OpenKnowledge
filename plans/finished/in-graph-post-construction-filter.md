# In-graph (post-construction) metadata filter panel

## Goal
Add a left-sliding panel in the OK-Graph **view** (after the graph is built) offering the
same controls as Panel 2's metadata filter (year, citation count, code/peer-reviewed/
open-access, archetypes, fields of study). Unlike the build-time filter — which decides
which nodes are *added* to the citation graph — this one filters **afterwards**: it only
hides the visibility of nodes that don't match. It must be fully revertible: resetting or
loosening the filter brings hidden nodes back.

## Key design
- Reuse the proven mechanism behind `onlyGoldNodes` / `onlySilverNodes`: the `laneLayout`
  computed filters `state.placed()` and recomputes the whole layout (lanes, blobs, edges,
  counts) as if dropped nodes were removed. Adding a reactive post-filter predicate to that
  same `.filter(...)` chain makes hiding/showing automatic and revertible — no node is ever
  mutated or deleted from `state`.
- Keep a **separate** filter state from the build-time `GraphFilterService` so the two
  never interfere (build-time filter is mirrored from Results + sticky; this one is a fresh,
  independent post-filter that resets to a no-op = show everything).

## Subtasks
1. **Extract a pure metadata predicate** from `GraphFilterService.nodePredicate` into an
   exported helper `metadataNodeMatches(m, n, seedScope)` and export `defaultMetadata`.
   Refactor `nodePredicate` to use it (no behavior change). Covered by existing specs.
2. **`GraphPostFilterService`** (`providedIn: 'root'`): holds `metadata` signal +
   mutators (updateMetadata / toggle+setAll archetypes & fields / resetMetadata),
   `hasActiveFilter` computed, and `nodePredicate(seedScope)` that keeps everything when
   no constraint is set. Independent of Results / build-time filter. New spec.
3. **`InGraphFilterPanelComponent`**: left-sliding panel mirroring the popup's controls,
   bound to `GraphPostFilterService`. Field/archetype counts come from the graph's own
   base nodes (`OkGraphStateService.nodes()`), not the Results set.
4. **Wire into `OkGraphComponent`**: inject service, `inGraphFilterOpen` signal + toggle,
   header button, mount panel in canvas-wrap, and apply the predicate in `laneLayout`
   (seed-scope per node via `state.initialSeedIds()`), so code/peer/archetype stay
   "seeds only" exactly like the build-time filter.

## Testing
- `GraphPostFilterService` spec: defaults keep all; constraints hide non-matching; reset
  restores; seed-scope passthrough for code/peer/archetype on expanded nodes.
- Existing `graph-filter.service.spec.ts` must stay green after the predicate extraction.
- Run via `npx ng test --watch=false --include='...'` (vitest builder initialises TestBed).
