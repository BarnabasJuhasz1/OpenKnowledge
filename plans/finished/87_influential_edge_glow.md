# 87 — Signal influential citations with an edge glow (drop text badges)

The always-on "Influential" text badges (plans 85/86) clutter dense graphs.
Replace them with a purely visual treatment: influential-citation edges **glow**
(soft gold halo + gentle pulse), preserving their cluster colour.

## Behaviour
- When the toggle is on (default), every influential-citation edge is drawn with
  a gold glow and a subtle pulse, so it reads as "highly influential" without any
  text. Cluster stroke colour is preserved (the glow is the only added signal).
- Influential edges keep a readable minimum opacity even when link-transparency
  is low, so the signal survives.
- The hover tooltip is unchanged (single edge, on demand — not clutter).

## Implementation

### `okgraph.component.ts`
- Rename `showInfluentialLabels` → `highlightInfluentialEdges` (default `true`).
- Remove the now-unused `influentialEdges` / `influentialEdgeLabels` computeds.
- Add `edgeOpacity(edge)`: hovered → 1; influential (when toggle on) →
  `max(base, 0.85)`; else the normal link-transparency base.
- Keep `edgeLabelText` / `edgeLabelPos` (still used by the hover tooltip).

### `okgraph.component.html`
- Edge `<path>`: add `--influential` class bound to
  `highlightInfluentialEdges() && isEdgeInfluential(edge)`; swap the inline
  opacity expression for `edgeOpacity(edge)`.
- Remove the persistent text-badge `@for` block.
- Settings row: relabel to "Highlight influential citations" /
  "make highly-influential edges glow", bound to the renamed signal.

### `okgraph.component.scss`
- `&__edge--influential`: gold drop-shadow glow, slightly thicker stroke,
  `ok-edge-glow` pulse keyframes. `prefers-reduced-motion` → static glow.
  `&--hovered` keeps its own primary-colour glow (animation disabled when both).

## Test
- `tsc --noEmit -p tsconfig.app.json` clean.
- `ng test --watch=false` green.
