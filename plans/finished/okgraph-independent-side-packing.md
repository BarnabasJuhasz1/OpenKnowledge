# ok-graph: independent left/right column packing (filter re-flow)

## Problem
After filtering a built/loaded graph, the layout left a large vertical gap where a now-
removed cluster used to be — e.g. a short red left-side cluster sat far below the seed
with empty space above it (image #13).

## Root cause
`packClusterLevels` built a **single shared Y-grid**: left[i] paired with right[i] on one
level, and `computeLevelCenters` spaced each level by the **max extent across both sides**.
A tall right-side cluster forced a big inter-level gap, which the short left-side cluster
on the same level inherited. So the left column was stretched to match right-column
heights. The layout *did* recompute on filter, but the geometry itself wasted the space.

## Fix
Replaced `packClusterLevels` (shared grid) with `packClusterBands` in `cluster-levels.ts`,
which packs the **left and right columns independently**:
- Centre column = seed cluster(s) + any non-seed cluster that spans the seed (full-width),
  stacked down the middle, shifted so the seed mean sits at relative y = 0.
- Each side fans above / below that centre band spaced by **its own** clusters' extents
  only. A short left cluster hugs the centre even when the right side is tall, and removing
  one side's clusters never leaves a gap sized by the other.
- Returns `Map<cluster, relativeY>` directly; the component's `levelOf` is now a plain map
  lookup. Still computed inside `laneLayout`, so it re-packs as filters add/remove clusters.

## Verify
- `tsc -p tsconfig.app.json --noEmit` clean.
- `ng test --watch=false` green (220/220). `packClusterLevels` tests replaced by 5
  `packClusterBands` tests: seed centred at 0, left+right share a row, **side packing is
  independent of the other side's height**, same-side clusters fan opposite, non-seed span
  treated as a centre-column row.
