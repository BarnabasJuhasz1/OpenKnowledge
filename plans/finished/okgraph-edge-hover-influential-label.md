# ok-graph — hover a highlighted edge to see its "influential" label

## Goal
In the ok-graph view, when a node is selected its incident edges are already highlighted
(`isEdgeHighlighted` + `edgeStroke`). Add: hovering a **highlighted** edge (a) emphasises it further
(thicker / full-opacity) and (b) shows a small label at the edge midpoint stating whether it is an
**influential** citation — placed *above* the edge for horizontal-ish edges, *beside* it for
vertical-ish edges (per the edge's dominant axis).

Builds on the backend `is_influential` flag now in the citgraph API (`CitGraphEdgeOut.is_influential`).

## Data flow (plumb the flag to the rendered edge)
The rendered edges are `LayoutEdge`s produced by `citationLinksBetweenPlaced(...)` from
`state.rawGraph().edges` (which are `CitGraphEdge`s). Edges may aggregate several underlying
citations when the view is clustered, so aggregate with **OR** (influential if any contributing
citation is influential).

1. `core/services/citgraph.service.ts` — add `is_influential?: boolean` to `CitGraphEdge`.
   (Backend always sends it; optional keeps the references-built "surrounding graph" path — which
   has no flag — valid. Those edges render as not-influential.)
2. `features/okgraph/graph-layout.ts`:
   - `LayoutEdge` += `isInfluential?: boolean`.
   - `citationLinksBetweenPlaced` rawEdges param type += `is_influential?: boolean`; track the
     pushed edge per undirected key and OR-in `is_influential` for every contributing raw edge.
3. The other `LayoutEdge` source — `state.links()` (manual expansion links) — are not citations;
   they keep `isInfluential` undefined (⇒ not influential). No change needed (field is optional).

## Interaction (okgraph.component.ts + .html + .scss)
4. State: `hoveredEdge = signal<LayoutEdge | null>(null)`; clear it when the selection changes
   (an edge that stops being highlighted must stop being hovered).
5. Template (`@for edge of edges()`):
   - Keep the visible `<path class="graph-svg__edge">`; add
     `[class.--highlighted]="isEdgeHighlighted(edge)"` and `[class.--hovered]="isEdgeHovered(edge)"`.
   - For **highlighted** edges only, render a transparent wide hit path
     (`graph-svg__edge-hit`, stroke-width ~14, `cursor: pointer`) with
     `(mouseenter)="onEdgeEnter(edge)" (mouseleave)="onEdgeLeave(edge)"` so the thin curve is easy
     to hover. Non-highlighted edges stay `pointer-events: none`.
   - After the nodes, render a single label group for `hoveredEdge()` at `edgeLabelPos(edge)`
     (midpoint + perpendicular offset chosen by dominant axis): a rounded `rect` + `text`
     ("Influential citation" / "Regular citation"), `pointer-events: none`.
6. Helpers: `isEdgeHovered`, `isEdgeInfluential(edge)` (reads `edge.isInfluential`),
   `edgeLabelText`, `edgeLabelPos` (uses `nodeMap()` endpoints; |dx|≥|dy| ⇒ label above, else beside),
   `onEdgeEnter/onEdgeLeave`.
7. SCSS: `--hovered` (full opacity, thicker stroke, subtle glow), `__edge-hit`
   (`stroke: transparent`), `__edge-label` (chip bg, readable text, `pointer-events: none`),
   `--influential` accent vs neutral.

## Tests
- `graph-layout.spec.ts`: extend `citationLinksBetweenPlaced` cases to assert `isInfluential`
  aggregates via OR (a True among contributors marks the merged edge; all-False stays False;
  absent flag ⇒ falsy).
- Run frontend vitest headless (per project convention).

## Done when
Hovering a highlighted edge thickens it and shows an accurate influential/regular label positioned
by the edge's orientation, and `citationLinksBetweenPlaced` OR-aggregation is covered by a passing test.
