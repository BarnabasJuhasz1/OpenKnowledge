# 88 — Wavy influential edges, mouse-following badge, hide non-incident edges

Three okgraph-view refinements.

## 1. Influential citations drawn wavy (replace the glow)
- Add `wavyEdgePath(from, to)` to `graph-layout.ts`: a tapered sine wave along the
  straight edge direction (amplitude fades to 0 at both ends so it meets nodes
  cleanly). Wavelength/amplitude tuned for a gentle ripple.
- `edgePath(edge)` returns the wavy path for influential edges (when the toggle is
  on), the normal bezier otherwise. The hit path follows the same `d`.
- Drop the glow filter/animation/keyframes. Rename `isEdgeGlowing` → `isEdgeWavy`.
- Keep the readable-opacity floor for influential edges when nothing is selected.

## 2. Hover badge follows the mouse
- Track the pointer in content space via a `mousemove` on the edge hit path
  (`getScreenCTM().inverse()` of the client point — the hit path lives inside the
  pan/zoom `contentTransform` group, so this yields node/edge coordinates).
- Store `hoverPos` signal; position the tooltip chip at the cursor (slightly
  above) instead of the edge midpoint. Replace `edgeLabelPos` with a small
  `edgeLabelHalfWidth` helper (the node-avoidance midpoint logic is no longer
  needed).

## 3. Hide non-incident edges while a node is selected
- `edgeOpacity(edge)`: hovered → 1; **when a node is selected**, incident
  (highlighted) edges stay visible and every other edge → 0 (fully invisible);
  otherwise follow link-transparency (with the influential floor).

## Test
- `tsc --noEmit -p tsconfig.app.json` clean.
- `ng test --watch=false` green.
