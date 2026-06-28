# ok-graph: funnel spokes (no blob overlap) + tighter level packing

Two visual refinements requested on top of the side-aware level packing.

## Task 1 — Remove redundant vertical space between clusters (image #8)
`computeLevelCenters` spaces adjacent levels by `max(BAND_SPACING, needed)`. For short
stacks `needed ≈ 120` (halfExtent 0 + padTop 40 + padBottom 50 + minClear 30) but the
`BAND_SPACING = 160` floor wins, leaving ~70px dead gaps. Lower the floor so short
clusters hug at the intended `minClear` (30px) gap.

- Change `BAND_SPACING` 160 → 120 in `okgraph.component.ts`.
- The extent-aware `needed` term still expands spacing for tall stacks, so blobs of
  multi-row clusters never overlap.

## Task 2 — Cluster blob funnels must not overlap (image #9)
Root causes in the blob loop of `laneLayout`:
1. Every cluster necks to `absCenterY` (the seed centre), so same-side clusters'
   funnels converge on one point and their bodies overlap.
2. The seed-side bezier cap bulges by `capDx ≈ 50px`, making each funnel tip a fat
   lobe that overlaps neighbours and creeps over the seed marker.

Fix — turn the funnels into radial spokes:
- Stagger the neck Y by a fraction of the cluster's band offset from the seed:
  `neckY = absCenterY + (bandY - absCenterY) * SEED_NECK_PULL` (new const ~0.22),
  where `bandY` is the cluster's mean packed centre. Clusters above the seed neck
  slightly above centre, those below neck below — fanning out as spokes that stay
  separated near the seed while still approaching the node edge from their own side.
- Tag the funnel-tip ("neck") points and draw the seed-side cap with a tiny `capDx`
  (~6px) so the tip is a thin point, not a bulbous lobe that overlaps and covers the seed.

## Verify
- `tsc -p tsconfig.app.json --noEmit` clean.
- `ng test --watch=false` green (existing packing tests unaffected; geometry change
  is inside the component, covered by type-check + visual confirmation).
