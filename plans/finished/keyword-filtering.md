# Feature: Keyword (title + abstract) filtering at two stages

## Goal
Let the user discard papers that do not match their keyword query
(`SearchStateService.rawQuery`, flattened via `parseQuery`) on a
title + abstract substring match. The filter can be enabled at either of
two stages:

1. **Cit-Graph (pre-clustering):** when on, non-matching papers are dropped
   from the citation graph *before* layout/Louvain, so they never enter the
   graph at all.
2. **OK-Graph (post-clustering):** even if stage 1 was off, the OK-Graph can
   filter out non-matching papers; the hierarchy is re-clustered *as if they
   were removed completely*, and they are added back when the filter is
   disabled.

**Constraint:** if stage 1 was on for the clustering that produced the
current OK-Graph, the OK-Graph filter is locked **on** (the papers were never
sent, so there is nothing to add back).

## Matching rule
- Keywords = `parseQuery(SearchStateService.rawQuery())`.
- A node matches if **any** keyword is a case-insensitive substring of
  `title + " " + abstract`.
- Empty keyword list → everything matches (filter is a no-op; UI disabled with
  a hint).
- The seed paper is **always kept** in stage 1 (filtering it would behead the
  citation graph).

## Subtasks

### 1. Shared matching utility
- `shared/utils/keyword-match.ts`:
  - `nodeMatchText(n)` → `(title + ' ' + (abstract ?? '')).toLowerCase()`.
  - `matchesKeywords(text, keywords)` → `keywords.length === 0 || some substring`.
  - `matchesNodeKeywords(node, keywords)` convenience for a `CitGraphNode`.

### 2. Stage 1 — Cit-Graph pre-clustering filter
- `CitGraphComponent`:
  - Inject `SearchStateService`; `keywords = computed(() => parseQuery(rawQuery))`.
  - `filterByKeywords = signal(false)`; `canFilter = computed(keywords>0)`.
  - In `buildGraph` `next`, if `filterByKeywords() && keywords().length`, filter
    `data.nodes` to (seed ∪ matching) and drop edges whose endpoints are gone,
    before `runLayout` / `runLouvain`.
  - When sending to OK-Graph, pass the prefiltered flag + keywords + edges +
    louvain params (see subtask 4).
  - UI: a toggle in the build/cluster controls, disabled when `!canFilter`,
    with a hint showing the keyword count / "run a search first".

### 3. Stage 2 — OK-Graph filter with re-clustering
- `OkGraphStateService`:
  - Store originals: `allNodes`, `allEdges` (paper_id form), `louvainParams`
    `{resolution, maxLevels}`, `keywords`, `prefiltered`, plus the original
    unfiltered `LouvainResult`.
  - `setHierarchy(nodes, louvain, opts)` extended with
    `{edges, resolution, maxLevels, keywords, prefiltered}`.
  - `filterActive` signal (init = `prefiltered`).
  - `applyFilter(on)`:
    - locked: if `prefiltered`, ignore attempts to turn off.
    - on → compute matching subset of `allNodes`, remap `allEdges` to new
      indices, run `louvain()`, set `nodes`+`louvain` to filtered versions.
    - off → restore `nodes = allNodes`, `louvain = original`.
    - clears `placed`/`links` so the OK-Graph view re-seeds top reps.
- `OkGraphComponent`: add the filter toggle to the settings panel (subtask
  built last turn). Disable + lock when `state.prefiltered()`; disable when no
  keywords. Tooltip explains the locked state.

### 4. Wire Cit-Graph → OK-Graph
- `sendRepresentativesToGraph` passes `edges` (`graphData().edges`, already
  filtered in stage 1 if it was on), `resolution`, `maxLevels`,
  `keywords()`, and `prefiltered = filterByKeywords() && keywords().length>0`.

### 5. Verify
- `npx ng build` succeeds (no template/TS/SCSS errors).
- Logic walk-through: stage-1 on removes nodes+edges pre-cluster; OK-Graph lock
  honored; stage-2 toggle re-clusters and restores; empty-keyword no-op.

## Notes
- Matching is **any-keyword OR** semantics (not all). `parseQuery` already
  drops boolean operators, so AND/OR structure isn't available here.
- Re-clustering on the OK-Graph reuses the same `louvain()` used by Cit-Graph,
  so the unfiltered view is identical to the current behavior (we only
  recompute when the filter is actually on).
- The seed paper is kept at **both** stages (the `seedId` is passed in the
  payload), so "filter on at Cit-Graph" and "filter on at OK-Graph" yield the
  same node set.

## Status: DONE
- `npx ng build` clean; both citgraph/okgraph chunks compile.
- `npx vitest run` — keyword-match + louvain specs pass (12 tests). The one
  failing suite (`app.spec.ts`) is a pre-existing scaffold test missing Vitest
  global imports; unrelated to this change.
