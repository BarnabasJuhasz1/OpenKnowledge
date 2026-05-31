# OK-Graph background exploration & clustering

## Goal
Make the OK-Graph "Explore" button (on the pre-clustering setup screen) build the
surrounding citation graph **and cluster it in the background**, the same way the
Clustering (Cit-Graph) page does — without the user switching to that page. The
result must also be reflected on the Clustering page.

When "Only Selected Papers" is on, the graph is built as: insert the seed papers,
then take the **K-hop neighbourhood** of each seed. Defaults: 2 hops, no per-hop
limit (all citations), Louvain resolution 0.5. These are configurable in Project
Settings. For now `past` / `context` / `future` all build the same neighbourhood.

## Decision
Build client-side by reusing the existing single-seed `/citgraph/build` endpoint
(`CitGraphService.build`/`buildDemo`), once per seed, then merge the sub-graphs.
No backend changes.

## Subtasks
1. `project-graph-settings.md` — per-project K-hop / max-per-hop / resolution
   settings (service + Project Settings UI).
2. `okgraph-explore-wiring.md` — wire `onExplore()` to build+merge+cluster in the
   background and push to the shared `OkGraphStateService`.
3. `clustering-page-reflection.md` — Cit-Graph page hydrates from the shared
   exploration result so it shows the same graph + clusters.

## Test
- `cd frontend && npm run build` must succeed (type-check + template compile).
- Manual: OK-Graph → select papers → pick a direction → Explore → canvas shows
  clustered swimlanes; Clustering tab shows the same graph.
