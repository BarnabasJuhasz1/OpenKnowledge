# v2 OK-Graph: tighten layout, show all citations, center the seed cluster

Scope: all changes are gated to **v2** graphs only (`OkGraphStateService.directionalSplit()` —
the construction flag of the *displayed* graph), so v1 graphs render exactly as before.
Everything lives in the `laneLayout` computed of `okgraph.component.ts` plus one helper
extension in `graph-layout.ts`.

## Subtask 1 — Remove inter-cluster bridges when cards are off
- Bridges (`buildBridges`) merge cluster blobs. In v2, when the in-graph lane cards
  visibility option is **off** (`!useInGraphCards()`), suppress them.
- Change the `bridges` assignment so it is `[]` when `v2 && !useInGraphCards()`.
- v1 and v2-with-cards keep the existing behaviour.

## Subtask 2 — Remove empty vertical padding around a cluster when cards are off
- Lane height currently floors at `LANE_MIN_HEIGHT` (220px) so a card fits, leaving a lot
  of empty vertical space when a lane holds only a node or two.
- In v2 with cards off, drop the `LANE_MIN_HEIGHT` floor and size the lane tightly to its
  content: `cellCount * LANE_NODE_VGAP + LANE_PAD`. Still clears the blob padding
  (`PAD_TOP`+`PAD_BOTTOM` = 90px) for a single-node lane (104px), so blobs don't collide.
- Card-driven lane growth is untouched (it only applies when cards are on).

## Subtask 3 — Make all citations visible by edges
- `citationLinksBetweenPlaced` currently drops cross-cluster citation edges (they were
  represented by bridges). Add an optional trailing `includeCrossCluster = false` param;
  when true, skip the same-cluster guard so every citation between two placed nodes draws.
- In v2, call it with `includeCrossCluster: true`. v1 keeps the default (false) so its
  behaviour and existing tests are unchanged.
- Add a unit test asserting a cross-cluster edge IS returned when the flag is on (and still
  dropped when off).

## Subtask 4 — Keep the seed cluster(s) in the middle (vertically centered lane)
- After `orderLanesByConnectivity` produces `laneClusters`, in v2 reorder so the cluster(s)
  containing seed papers sit contiguously in the middle of the lane stack, with the other
  lanes split evenly above and below (preserving their relative order).
- Seed clusters = current-view clusters of any placed node whose paper id is in
  `initialSeedIds`.

## Testing
- `graph-layout.spec.ts`: existing 6-arg calls unchanged; add cross-cluster on/off cases.
- Full frontend suite via `npm test` (TestBed env), plus `tsc --noEmit`.
