# Subtask: Reflect the OK-Graph exploration on the Clustering page

## What
After the OK-Graph builds + clusters in the background, the Clustering (Cit-Graph)
page should show the same graph and clustering when the user navigates to it.

## Approach
`OkGraphStateService` already receives the raw nodes/edges/resolution/seedId via
`setHierarchy`. Expose them as a shared `rawGraph` signal; the Cit-Graph component
hydrates from it on construction when it has no graph of its own.

## Files
- EDIT `frontend/src/app/core/services/okgraph-state.service.ts`
  - add `readonly rawGraph = signal<{ nodes: CitGraphNode[]; edges: CitGraphEdge[];
    seedId: string; resolution: number } | null>(null);`
  - set it inside `setHierarchy(...)`; reset to `null` in `clear()`.
- EDIT `frontend/src/app/features/citgraph/citgraph.component.ts`
  - add a `constructor()` that, when `okGraphState.rawGraph()` exists and
    `graphData()` is empty, rebuilds local display state:
    `graphData.set({nodes, edges, seed_id})`, `resolution.set(...)`,
    `layoutEdges.set(edges)`, `runLayout(data)`, `runLouvain()`.

## Test
`npm run build`; Explore on OK-Graph, then open the Clustering tab → same graph
with the same clusters (resolution 0.5).
