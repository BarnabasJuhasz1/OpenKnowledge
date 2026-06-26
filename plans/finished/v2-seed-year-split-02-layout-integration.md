# v2 seed-year split — 02 · laneLayout integration

Wire the pure `computeSeedYearSplit` (plan 01) into `laneLayout` in
`okgraph.component.ts` so split years widen and place nodes by sub-column. Active
**only** when `this.state.directionalSplit()` is true; otherwise the layout is
byte-for-byte the current behaviour (single x per year).

## Constants
- `SUBLANE_GAP = 110` — horizontal spacing between sub-columns within one year
  (< `YEAR_GAP = 180`, so a 3× year still reads as one column visually).

## Variable-width year x (replaces uniform `yearX`)
Current: `years.forEach((y,i)=> yearX.set(y, leftPad + i*YEAR_GAP))` — one x/year.

New (only differs when `directionalSplit` and a year is in `rolesByYear`):
- Compute `split = directionalSplit ? computeSeedYearSplit(splitNodes, edges) : empty`,
  where `splitNodes = placedFiltered.map(p => ({ id: p.id, year: p.paper.year!,
  isSeed: seedIds.has(paperId(p.paper)) }))` and `edges = rawGraph()?.edges ?? []`.
- Walk `years` left→right with a cursor:
  ```
  let cur = leftPad;
  for (const y of years) {
    const roles = split.rolesByYear.get(y);          // undefined ⇒ single column
    const slots = roles?.length ?? 1;
    const span  = (slots - 1) * SUBLANE_GAP;
    yearCenterX.set(y, cur + span / 2);
    if (roles) roles.forEach((r, j) => subColX.set(`${y}|${r}`, cur + j*SUBLANE_GAP));
    cur += span + YEAR_GAP;                            // gap to next year
  }
  ```
- `xForNode(p)`: `const roles = split.rolesByYear.get(y); if (!roles) return
  yearCenterX.get(y)!; const r = split.roleOf.get(p.id); return r ?
  subColX.get(`${y}|${r}`)! : yearCenterX.get(y)!;`

Replace every existing `yearX.get(year)` read:
- Node placement (`const x = ...`): use `xForNode(p)`.
- Blob backbone points, dividers, width, `buildBridges(..., yearCenterX)`, the
  returned `yearColumns` ⇒ use `yearCenterX.get(y)` (column centre). Axis labels &
  year-gap markers consume `yearColumns[].x`, so centring keeps them correct.
- Anchor translation (`dx`): also offset every `yearCenterX` and `subColX` value
  (currently offsets `yearX`).

## Per-cell sub-column stacking
Cells keyed `lane|year` stack members vertically on `laneCenter`. Now, within a
split year, members at *different* sub-x must stack independently:
- After sorting a cell's members by ok-score, group them by `xForNode(p)` and
  stack each x-group vertically centred on `laneCenter` (reuse the existing
  `(j-(k-1)/2)*LANE_NODE_VGAP` formula per group). Non-split years have one group
  ⇒ identical to today.
- `boxes` (cluster bbox) already takes `min/max` of actual node x/y, so it widens
  automatically.

## Dividers / width
- Divider between consecutive years i, i+1: midpoint of year-i right edge
  (`centerX_i + span_i/2`) and year-i+1 left edge (`centerX_{i+1} - span_{i+1}/2`).
  Track `span` per year to compute. Keeps the line out of the widened columns.
- `width = lastRightEdge + 80` (track the cursor's last right edge).

## Blobs (cosmetic)
Blob backbone stays at `yearCenterX`. A cluster node pushed to a sub-x can extend
≤ `SUBLANE_GAP/2` past the band; acceptable for this dev feature. (Optional: bump
`PAD_X` for split years — skip unless it looks wrong in verify.)

## Tests / verify
- `seed-year-split.spec.ts` green (plan 01).
- Extend `okgraph` layout coverage if a `graph-layout`/component spec exists for
  year x; otherwise rely on the pure spec + manual verify.
- `tsc --noEmit -p tsconfig.app.json` clean; `ng test --watch=false` green.
- Manual: build a v2 'both' graph with a seed citing & cited-by same-year papers →
  that year column is ~3× wide, seed isolated in the middle-right, refs left,
  citers right, `other` far left; v1 graphs and non-seed years unchanged.
