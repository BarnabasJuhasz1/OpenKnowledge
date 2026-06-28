# ok-graph: compact cluster card with select-to-expand

## Goal
Shrink the on-graph cluster card (`.lane-box`) to a compact form that saves vertical
space. By default a card shows only:
- the cluster **title** (left), and
- on the right, the **paper count** and **sub-cluster count**.

Selecting the cluster (clicking the card, its blob, or a node in it) **expands** the
card to the current full "cluster paper view" (summary title, bullets, expandable
summary, and the expand/move/delete action buttons). Clicking the expanded card again
collapses it back to compact.

## Current state (where things live)
- `okgraph.component.html` ~line 1000–1117: the `@for (box of laneLayout().laneBoxes)`
  block renders each card. The `.lane-box__header` (swatch + title + `__aside`/`__counts`)
  is already exactly the compact content. Below it sit `.lane-box__main`
  (bullets + `.lane-box__actions`) and the full-width `.lane-box__summary-toggle`.
- `okgraph.component.ts`:
  - `selectedClusterId` signal + `isClusterSelected(topCluster)` (~2841).
  - `selectClusterById(id, event)` (~2896) — the card click handler; today it only sets
    (never clears) the selection. Only used by the card.
  - `cardHeightFor` / `cardHeights` ResizeObserver: cards are content-measured, so a
    compact card automatically reports a shorter height — no manual height math needed.
- `okgraph.component.scss` ~2389 `.lane-box` and modifiers.

## Changes
1. **Template** (`okgraph.component.html`): gate the card body on selection.
   - Wrap `.lane-box__main` and the trailing summary-toggle block in
     `@if (isClusterSelected(box.topCluster)) { ... }`.
   - Add `[class.lane-box--compact]="!isClusterSelected(box.topCluster)"` on the card
     root for styling.
   - Header (title + counts) stays unconditional → it is the compact card.
2. **Behavior** (`okgraph.component.ts`): make `selectClusterById` toggle, so clicking an
   already-expanded card collapses it:
   `this.selectedClusterId.update(cur => (cur === id ? null : id));`
   (Action buttons already `stopPropagation`, so they don't collapse the card.)
3. **SCSS** (`okgraph.component.scss`): under `.lane-box`, add a `&--compact` rule that
   drops the header's bottom margin to 0 (no body follows) so the compact card is tight.

## Out of scope / preserved
- The non-in-graph `.cluster-popup` side panel (`!useInGraphCards()` path) is unchanged.
- Counts already live in the header (`__counts`: papers always; sub-clusters when > 0),
  so no count markup moves.
- Blob/node selection still expands the matching card (they set `selectedClusterId`).

## Verify
- `npx tsc -p tsconfig.app.json --noEmit` clean.
- `npx ng test --watch=false` green (existing suite; no spec covers this template-only
  toggle — behavior is a one-line signal toggle).
- Manual: compact cards by default; click expands to full card; click again / background
  collapses; bare-seed clusters still show no card (prior fix intact).
