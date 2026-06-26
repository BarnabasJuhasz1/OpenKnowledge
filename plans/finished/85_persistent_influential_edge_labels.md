# 85 — Persistent "Influential citation" edge labels (default-on visibility toggle)

## Goal
Add a boolean visibility option to the OK-Graph view, **on by default**, that renders the
phrase "Influential citation" on top of every influential citation edge — even when the edge
is not selected or hovered. When the toggle is off, behaviour is unchanged (the phrase only
appears in the existing hovered-edge tooltip).

## Existing machinery (reuse)
- `LayoutEdge.isInfluential` already carries S2's per-edge flag (aggregated in
  `graph-layout.ts`).
- `edges()` computed exposes the current view's `LayoutEdge[]`.
- `edgeLabelPos(edge)` / `edgeLabelText(edge)` already compute chip placement + text, and the
  `.graph-svg__edge-label--influential` SCSS gives the gold styling. The hovered-edge tooltip
  block (HTML ~1180) uses all of this.

## Subtasks

### 1. Component state (`okgraph.component.ts`)
- Add `readonly showInfluentialLabels = signal(true);` near the other visibility signals
  (`showSeedMarkers`, `showGoldStars`).
- Add `readonly influentialEdges = computed(() => this.edges().filter(e => e.isInfluential));`
  near the `edges()` computed.

### 2. Persistent labels (`okgraph.component.html`)
- After the hovered-edge tooltip block, add a block guarded by `@if (showInfluentialLabels())`
  iterating `influentialEdges()`. For each, render the same chip `<g>` markup with the
  `--influential` class. Skip the edge currently under the hover tooltip (`!isEdgeHovered`)
  so the persistent label doesn't double-draw over the hover tooltip.
- Mark these chips `--persistent` for styling.

### 3. Toggle UI (`okgraph.component.html`, graph-settings panel)
- Add a `graph-settings__row` switch mirroring the "Seed icons" row, bound to
  `showInfluentialLabels` (label "Influential citation labels", hint "always show the badge on
  influential edges").

### 4. Styling (`okgraph.component.scss`)
- Add `.graph-svg__edge-label--persistent { opacity: 0.9; }` so always-on labels read a touch
  softer than the active hover tooltip but stay legible.

## Verification
- `tsc --noEmit -p tsconfig.app.json` clean.
- `ng test --watch=false` suite green (no regressions; feature is presentational).
