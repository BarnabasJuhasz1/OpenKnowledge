# 86 — Influential edge label: readability fixes

Refines the always-on "Influential citation" badge (plan 85) so it stays legible.

## Requirements
1. **Never overlap a node.** The badge must not sit on top of any node circle.
2. **Shorter text:** render `Influential` instead of `Influential citation`.
3. **Smaller chip:** reduce font size, chip height and padding.
4. **Hug the edge more:** reduce the perpendicular offset from the edge.
5. **Opaque background:** the chip background must be fully non-transparent so
   edges/nodes never show through it.

## Implementation

### `okgraph.component.ts`
- `edgeLabelText`: influential → `'Influential'` (non-influential hover keeps
  `'Regular citation'`).
- `edgeLabelPos`: smaller `halfWidth`, smaller perpendicular `OFFSET`, and a
  **node-avoidance search** — slide the chip anchor along the edge over a set of
  parametric `t` values and pick the position with the greatest clearance from
  every node (inflated-rect gap test). Break on the first fully-clear, most
  central spot.
- `influentialEdgeLabels` computed: precompute `{edge, x, y, halfWidth, text}`
  once per dependency change instead of recomputing position per edge each CD.

### `okgraph.component.html`
- Hover + persistent rects: smaller dims (`y="-9" height="18" rx="9"`).
- Persistent loop iterates `influentialEdgeLabels()` (precomputed positions),
  still skipping the hovered edge.

### `okgraph.component.scss`
- Influential `&-bg` fill → opaque surface (gold border kept).
- `&-text` font-size → 10px.
- `&--persistent` opacity → 1.

## Test
- `tsc --noEmit -p tsconfig.app.json` clean.
- `ng test --watch=false` green (presentational change; existing suite must pass).
