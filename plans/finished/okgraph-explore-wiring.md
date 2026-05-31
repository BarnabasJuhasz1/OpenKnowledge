# Subtask: Wire OK-Graph Explore to background build + cluster

## What
Replace the stub `onExplore()` in `okgraph.component.ts` so clicking Explore
builds the surrounding graph from all seeds and clusters it in the background.

## Files
- EDIT `frontend/src/app/features/okgraph/okgraph.component.ts`
  - imports: `forkJoin` from `rxjs`; `CitGraphNode, CitGraphEdge, CitGraphResponse`
    from `citgraph.service`; `ProjectGraphSettingsService`; `ProjectContextService`.
  - inject `projectContext`, `graphSettings`.
  - `const UNLIMITED_PER_HOP = 100000;` (sentinel for "no limit").
  - `onExplore()` → calls new `exploreFromSeeds(direction)`.
  - `exploreFromSeeds(direction)`:
    - seeds = `useOnlySelected() ? selectedPapers() : filteredPapers()`.
    - load `{ kHops, maxPerHop, resolution }` from project settings.
    - for each seed `build(paperId, kHops, maxPerHop ?? UNLIMITED_PER_HOP)`
      (or `buildDemo`), `forkJoin` them.
    - merge: union nodes by `paper_id` (keep min `hop`), union edges (dedup, both
      endpoints present).
    - `louvain(nodes.length, mappedEdges, { resolution, maxLevels: 10 })`.
    - `state.setHierarchy({ nodes, louvain, edges, resolution, maxLevels: 10,
      keywords, seedId: firstSeed, prefiltered: false })`.
    - drive `explorationLoading` / `explorationError`.
  - `past` / `both` / `future` behave identically for now.

## Test
`npm run build`; clicking Explore populates the OK-Graph canvas.
