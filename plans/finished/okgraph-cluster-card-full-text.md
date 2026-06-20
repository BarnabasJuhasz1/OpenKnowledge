# OK-Graph cluster cards: never-truncated title/description + counts

## Goal
On the in-graph cluster cards (`useInGraphCards`) in the OK-Graph view:
1. **Title (`name`) and description (summary title + summary text) must never be truncated** — always fully visible. Today the card has a fixed height (`cardHeight = 150`) and the summary is `-webkit-line-clamp`-ed to 3 lines, so longer text is cut off.
2. **Make the layout more compact** by moving the full-height right-side **"Move Inside"** button into a compact icon button in the card's top-right corner (next to the delete trashcan).
3. **Show how many sub-clusters and papers** are inside the cluster somewhere on the card.

## Approach

### A. Dynamic card height (so nothing truncates)
A `foreignObject` clips its HTML content to its `width`/`height`, so a fixed height truncates. Make the height per-card and content-driven:
- Add `cardHeights = signal<Map<number, number>>(new Map())` and `cardHeightFor(topCluster)` returning the measured height or a fallback (`CARD_HEIGHT_FALLBACK = 160`).
- Bind `foreignObject` `height` and the vertical-centering `y` to `cardHeightFor(box.topCluster)` instead of the fixed `cardHeight`.
- Measure each rendered `.lane-box` with a single `ResizeObserver` created in `ngAfterViewInit`. The inner div uses `height: auto`, so its `offsetHeight` is the true content height (independent of the foreignObject clip and unaffected by the canvas zoom transform — unlike `getBoundingClientRect`). Read `el.offsetHeight`, key by a `data-cluster` attribute, push into `cardHeights`.
- Re-observe whenever the `@ViewChildren` QueryList changes (clusters added/removed, view drilled).
- No observer loop: the div height is `auto` and does not depend on the foreignObject height, so setting the foreignObject height never re-triggers a content resize.

### B. Compact layout
- `.lane-box` becomes a single vertical column (`flex-direction: column`); drop the right-hand full-height move button column.
- Header row: swatch → title group (grows) → compact **Move Inside** icon button → delete trashcan.
- Title wraps fully (`white-space: normal; overflow-wrap: anywhere`).
- Summary: remove `-webkit-line-clamp`/ellipsis so the whole text shows.

### C. Counts
- Add a pure `subclusterCount(parentComm, childComm, topCluster)` to `cluster-ops.ts` (+ spec) counting distinct child communities (one level finer) among the cluster's members.
- In the `laneBoxes` builder add `paperTotal` (number) and `subClusters` (only meaningful when `currentTopLevel >= 1`; child level `-1` is leaf == papers).
- Render a small meta row on the card: `N papers` and, when `subClusters > 0`, `· M sub-clusters`.

## Files
- `frontend/src/app/features/okgraph/cluster-ops.ts` (+ `.spec.ts`) — `subclusterCount`.
- `frontend/src/app/features/okgraph/okgraph.component.ts` — dynamic height plumbing + counts in `laneBoxes`.
- `frontend/src/app/features/okgraph/okgraph.component.html` — foreignObject height/y, card markup.
- `frontend/src/app/features/okgraph/okgraph.component.scss` — `.lane-box` restyle.

## Testing
- `ng test` for the new `subclusterCount` spec (pure function, follows existing `cluster-ops.spec.ts` pattern).
- Manual: long summaries fully visible, counts correct, move-inside in top-right, no truncation.
