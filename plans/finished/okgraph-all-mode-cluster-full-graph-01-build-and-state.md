# ok-graph 'all' mode — cluster the full k-hop graph, hide intermediates (01: build + state)

## Goal (pipeline change)
Replace the current **contract-then-cluster** `all`-mode pipeline with
**cluster-the-full-graph-then-hide-intermediates**:

1. Expand the k-hop neighbourhood on the backend from every retrieved paper
   (unchanged: forced `direction:'both'`, `directional_split:false`, structure-only).
2. Build the **FULL** base graph = retrieved papers (rich client nodes, `hop 0`)
   **+ intermediate connector papers** (backend nodes, `hop > 0`) **+ all edges**
   among them, in one id space. (No contraction.)
3. Run Louvain over the **full** graph and store it as the base graph (`nodes`,
   `edges`, `louvain`, `rawGraph`).
4. **Hide** the intermediate nodes in the OK-Graph view: they participate in
   clustering but are never placed, never chosen as cluster representatives, and
   not counted as cluster papers.

Rationale: clustering on the richer full graph groups retrieved papers by their
actual shared citation neighbourhoods (via connector hubs), instead of on a
lossy contracted multi-hop edge set. Storing the full graph as `rawGraph` keeps
the summary service and the Clustering (Cit-Graph) page consistent — both
re-derive the identical deterministic Louvain from it.

## Node identity (unified id space)
Backend `res.nodes`/`res.edges` are keyed by corpusid (`paper_id`) and already
contain the retrieved papers as `hop 0`. We keep retrieved papers in **client
`paperId` space** (so they carry archetypes/ok-score fields and match the rest of
the UI), and intermediates in **corpusid space**:

- `clientToId: Map<corpusid, clientPaperId>` — built (as today) by matching each
  backend node's `paper_id`/`doi`/`arxiv_id` (lower-cased) against the seed
  `identifierToId` map.
- **Retained nodes**: the client nodes built from `seeds` (all retrieved papers,
  `hop:0`) — kept exactly as today, so every retrieved paper stays a node even if
  the backend didn't resolve it.
- **Intermediate nodes**: every `res.nodes` entry with **no** `clientToId` mapping,
  kept as-is (corpusid `paper_id`, backend `hop > 0`).
- **Full edges**: for each `res.edges` `{source,target}`, map each endpoint
  `id → clientToId.get(id) ?? id`. Keep only edges whose both endpoints are
  present in the full node set; drop self-loops. (Edges between two retained
  papers, retained↔intermediate, and intermediate↔intermediate all kept.)
- Full base nodes = `retainedNodes ++ intermediateNodes`.

Louvain runs over the full node list with edges re-indexed via `indexOf`
(same mechanism as today). Store with `hideIntermediates: true`.

## Component change (`okgraph.component.ts`, `exploreSurrounding`, `all` branch)
- Remove the `contractMultiHopEdges` call + import (helper becomes unused; leave
  the file/spec in place, now superseded).
- In `next(res)`: build `clientToId` (as today), then build `intermediateNodes`,
  `fullNodes`, `fullEdges` per above. Cluster `fullNodes`+`fullEdges`. Call
  `setHierarchy({ ... nodes: fullNodes, edges: fullEdges, louvain, ...,
  hideIntermediates: true })`.
- Success toast counts **retained** papers (`seeds.length` / retained count), not
  full-graph node count, so the user sees "their" paper count.

## State change (`okgraph-state.service.ts`)
- `HierarchyPayload`: add `hideIntermediates?: boolean`.
- Add `readonly hideIntermediates = signal(false)`.
- In `setHierarchy`: set the signal; **after** `removedIds.set(new Set())`, when
  `hideIntermediates` is true, seed `removedIds` with every node id where
  `hop > 0`. The existing view already excludes `removedIds` everywhere it picks
  representatives / places leaves / counts members, so intermediates become
  invisible with **no per-call-site view edits**. Broaden the `removedIds` doc to
  "non-displayable base nodes (user-removed OR hidden intermediate connectors)".
- `clear()`: reset `hideIntermediates` to false.
- Snapshot round-trip: `exportSnapshotGraph` includes `hideIntermediates`;
  `loadSnapshotGraph` passes it into `setHierarchy` — so a reloaded snapshot
  re-seeds `removedIds` from `hop > 0` and intermediates stay hidden.
- `SnapshotGraph` (`graph-snapshot.service.ts`): add `hideIntermediates: boolean`.

## View polish (`okgraph.component.ts`)
- `clusterSize(level, community)`: exclude `removedIds` so cluster sizes / "cluster
  of N papers" reflect only visible (retained) papers, not hidden intermediates.
- `isViewClustersDisabled`: count non-removed (visible) nodes, not full-graph
  nodes, so the full graph's intermediates don't trip the 3000-node cap.

## Test / verify
- `npx tsc --noEmit -p tsconfig.app.json` clean.
- Existing okgraph component + state specs still pass.
- Manual smoke: build `all` mode; confirm only retrieved papers render, clusters
  reflect full-graph structure, sizes exclude intermediates.
