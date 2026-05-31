# Group disconnected nodes into a single "Miscellaneous" cluster

## Problem
When a keyword filter is applied *before* clustering (the Cit-Graph `prefiltered`
path, or the OK-Graph `setFilter` re-cluster), removing non-matching papers also
removes the citation edges that connected them. This leaves many degree-0
(disconnected) nodes. In Louvain a degree-0 node never moves, so it stays a
singleton community at every level — and therefore surfaces as its **own
highest-level cluster** (its own lane / blob in the OK-Graph). The canvas fills
with dozens of one-paper clusters.

## Desired behaviour
Every disconnected node must end up in **one** shared cluster called
"Miscellaneous", which is a single highest-level cluster (one lane / blob).
Scope: **always** — independent of whether a filter caused the disconnection
(confirmed with the user).

## Subtasks

### 1. Louvain: merge disconnected nodes (core)
File: `frontend/src/app/features/citgraph/louvain.ts`
- Detect isolated nodes (no incident edges) while/after building adjacency.
- Seed them all into one shared level-0 community (`miscSeed = first isolated
  index`) before the local-move passes. Because they have no edges they never
  merge with anything and travel together up the whole dendrogram, ending as a
  single top-level cluster.
- Handle the `nodeCount === 0` and `totalWeight === 0` (no edges at all) paths.
- Expose `miscCommunity: number | null` on `LouvainResult` — the level-0
  community id of the group, or null when there are no isolated nodes. The UI
  uses it to find and label the misc cluster.

### 2. Tests
File: `frontend/src/app/features/citgraph/louvain.spec.ts`
- Replace the old "isolated nodes → own communities" test (behaviour changed).
- Add: all-isolated graph collapses to one community with `miscCommunity` set.
- Add: a connected cluster + several orphans → orphans share one top cluster,
  distinct from (and not merged into) the real cluster.

### 3. OK-Graph: label + colour the misc cluster
File: `frontend/src/app/features/okgraph/okgraph.component.{ts,html}`,
`community-colors.ts`
- Find the misc top-cluster id from `louvain().miscCommunity` composed up to the
  top level.
- Render its blob with a neutral grey colour and a "Miscellaneous" label.

## Testing
- `npx vitest run louvain` for the unit tests.
- Build / manual check of the OK-Graph with a filter applied (many orphans).
