# OK-Graph: pack cluster levels to remove wasted vertical space

## Problem
Each top-level cluster currently sits in its own full-width horizontal band
(one vertical *level* per lane, stacked cumulatively in `okgraph.component.ts`
via `computeLevelCenters` over `laneClusters`). A cluster that only spans the
right of the seed still reserves a whole level, leaving the left half of that
level empty — so the canvas is mostly blank (see screenshot: tall stack of
single-cluster rows). The seed-funnel rework means every cluster's blob now
funnels to **one side** of the seed:

- left of the seed  → blob occupies `[memberMinX-PAD, seedX]`
- right of the seed → blob occupies `[seedX, memberMaxX+PAD]`
- spanning (members both sides, e.g. the seed's own cluster) → whole width

A left cluster and a right cluster therefore **never overlap horizontally** and
can share the same vertical level — funnelling into the seed from opposite sides
(the radial "spoke" look in the user's sketch). Two clusters on the *same* side
both funnel into the same seed edge, so they may **not** share a level.

## Approach
Replace the 1-level-per-lane assignment with a side-aware packing:

1. Classify each cluster as `left` / `right` / `span` from its non-seed members'
   x-extent vs the mean seed x (`seedRefX`). Seed's own cluster(s) are centred.
2. Pair the k-th left cluster with the k-th right cluster onto one shared level.
   Spanning clusters take a level alone. Seed cluster(s) form the centre level.
3. Fan the non-centre levels symmetrically above/below the centre (most-central
   pair nearest the seed), so the seed row stays at relative y = 0.
4. `halfExtent` per level = max of its members' tallest stacked cell, fed to the
   existing `computeLevelCenters` so neighbouring blobs still never overlap.

Because this is recomputed inside the `laneLayout` computed signal, it updates
automatically as clusters are expanded/collapsed (sides re-classify, levels
re-pack) — no stale positions.

## Files
- `cluster-levels.ts`: new pure `packClusterLevels(order, sideOf, halfExtentOf,
  seedClusters)` → `{ levelOfCluster, halfExtents, centerIndex }` (+ spec).
- `okgraph.component.ts`: compute `seedRefX`, per-cluster x-extent + side +
  half-extent, call `packClusterLevels`, derive `levelOf` from the packed levels
  (replacing the `seedRank` / per-lane `halfExtents` / `levelCenterAtRank` block).

## Tests
- `cluster-levels.spec.ts`: left+right pair share a level; same-side clusters get
  distinct levels; span/seed cluster centred; halfExtent = max of level members;
  centerIndex points at the seed level.
- Full `ng test` headless suite stays green; `tsc` clean.

## Done when
Left- and right-side clusters share vertical levels (canvas no longer mostly
empty), the seed cluster stays centred, blobs never overlap, and the layout
re-packs on expand.
