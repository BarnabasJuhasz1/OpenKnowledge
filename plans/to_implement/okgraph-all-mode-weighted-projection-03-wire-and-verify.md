# ok-graph 'all' mode — weighted projection (03: wire into build + verify)

## Goal
Use `buildRetrievedProjection` (subtask 01) in the `'all'` build path when
`ALL_CLUSTER_SUBSTRATE === 'projection'` (subtask 02), while leaving the existing
full-graph branch reachable when it's `'full-graph'`.

## File
`frontend/src/app/features/okgraph/okgraph.component.ts` — the `'all'` build
`next:` handler (`okgraph.component.ts:714-805`).

### What stays the same
- The whole expansion request (`allExploreReq`, `okgraph.component.ts:696-711`)
  and the response → unified-index-space mapping
  (`clientToId`, `intermediateNodes`, `fullNodes`, `presentIds`, `fullEdges`,
  `indexOf`, `mappedEdges` — `okgraph.component.ts:725-771`). The projection needs
  the full-graph adjacency, which is exactly `mappedEdges`.

### Branch on substrate
Read the flag once near `const resolution = cfg.RESOLUTION;`
(`okgraph.component.ts:623`):

```ts
const substrate = cfg.ALL_CLUSTER_SUBSTRATE ?? 'full-graph';
```

Then, after `mappedEdges` is built (`okgraph.component.ts:769-771`), replace the
single `louvain(fullNodes.length, mappedEdges, …)` call
(`okgraph.component.ts:773-776`) with a branch:

**`'full-graph'` (unchanged):**
```ts
baseNodesForView = fullNodes;
louvainEdges      = mappedEdges;
louvainNodeCount  = fullNodes.length;
hideIntermediates = true;
```

**`'projection'` (new):**
```ts
const projEdges = buildRetrievedProjection(
  nodes.length,          // retainedCount (retained papers are indices 0..n-1)
  fullNodes.length,      // fullNodeCount
  mappedEdges,
  {
    minWeight:        cfg.PROJECTION_MIN_WEIGHT,
    hubDiscount:      cfg.PROJECTION_HUB_DISCOUNT,
    directEdgeBonus:  cfg.PROJECTION_DIRECT_EDGE_BONUS,
  },
);
baseNodesForView  = nodes;        // retained only — intermediates are NOT nodes here
louvainEdges      = projEdges;
louvainNodeCount  = nodes.length;
hideIntermediates = false;        // nothing to hide; node set is already retrieved-only
```

Then the shared tail:
```ts
const louvainResult = louvain(louvainNodeCount, louvainEdges, {
  resolution, maxLevels: 10,
});
```
and pass `nodes: baseNodesForView`, `edges:` (the projection edges for the
projection branch — `CitGraphEdge` has no weight field, so store the projection's
`{source,target}` pairs; weight is only needed for clustering, not for the view's
edge rendering), and `hideIntermediates` into `setHierarchy`
(`okgraph.component.ts:789-802`).

### `edges` payload note
`setHierarchy` stores `edges` for later (snapshot, edge rendering). In the
projection branch the rendered nodes are the retained papers, so pass projected
retained↔retained edges as `{ source, target }` (drop `weight`). This keeps the
on-canvas edges meaningful (they connect visible papers) instead of dangling to
hidden intermediates. Confirm edge rendering tolerates the smaller/weighted set —
it only reads `source`/`target` (`CitGraphEdge`, `citgraph.service.ts:32`).

### `clustersCount` for progress
`new Set(topComm).size` (`okgraph.component.ts:778-780`) now counts top-level
communities over the **retained** node set directly — i.e. the real visible
cluster count, no longer inflated by pure-intermediate communities. No code
change, but the number shown during build becomes accurate as a side effect.

## Summaries — no change needed
Subtask 02 of the *full-graph* feature filtered hidden members out of summary
input (`cluster-summary.service.ts`, see
`plans/finished/okgraph-all-mode-cluster-full-graph-02-summaries-retrieved-only.md`).
With `hideIntermediates: false` and a retrieved-only node set, that filter is a
no-op and summaries naturally run over all (retained) members. Verify the summary
service reads `okGraphState.hideIntermediates()` and degrades cleanly when false.

## Verify (manual A/B — the point of keeping both substrates)
1. `npx tsc --noEmit -p tsconfig.app.json` clean; `npx vitest run okgraph`.
2. Run a real `'all'` build (the 75-paper query from the report) with
   `ALL_CLUSTER_SUBSTRATE: 'projection'`. Expect **far fewer** top-level clusters
   and very few single-paper clusters; truly unrelated papers land in
   Miscellaneous (not as singletons).
3. Flip to `'full-graph'`, rebuild the same query, compare cluster count and the
   number of single-paper clusters. Record both in the PR / plan-completion note.
4. Sweep `PROJECTION_MIN_WEIGHT` (e.g. 1 → 2 → 3) and confirm it trades cluster
   density against Miscellaneous size as designed; pick a default that gives a
   readable number of multi-paper clusters for a typical query.
5. Sanity: cluster summaries describe only retrieved papers (no connector titles);
   drill-in, "remove cluster", and Miscellaneous labelling still work.

## Completion
Move all three `okgraph-all-mode-weighted-projection-0*.md` files to
`./plans/finished/` only after tsc + vitest pass **and** the manual A/B in step 2
shows the cluster-count improvement on a real query.
