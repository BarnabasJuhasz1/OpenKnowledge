# ok-graph 'all' mode multi-hop — 02: backend expansion + multi-hop contraction

## Goal
Change the OK-Graph **`all`** construction so it:
1. expands the citation graph **k hops** on the backend (real BigQuery edges +
   intermediate OpenSearch nodes), using *every* retrieved paper as a seed;
2. **contracts** that k-hop graph down to the retrieved papers only — an edge
   `A → B` between two retrieved papers exists iff a directed citation chain
   connects them through zero or more *non-retrieved* intermediate papers;
3. runs **Louvain** over that retrieved-only multi-hop graph;
4. visualizes and summarizes **only the retrieved papers**.

This is the "contract, then cluster" design (chosen by the user). It keeps the
graph self-consistent with `ClusterSummaryService`, which re-runs Louvain on the
stored `rawGraph()` (nodes + edges) to reproduce community ids — so the stored
nodes/edges must *be* the multi-hop graph that gets clustered, shown and
summarized. Edges shown are therefore multi-hop reachability, **not** literal
single citations (as the user noted).

No backend change: `/explore` already returns the full k-hop graph with `hop`
markers (seeds = `hop 0`). Contraction is done client-side.

## Why a separate pure helper
Extract the contraction into a pure, unit-testable function so it can be tested
without the Angular component / HTTP (subtask 03).

New file: `frontend/src/app/features/okgraph/multi-hop-contract.ts`

```ts
import { CitGraphNode, CitGraphEdge } from '../../core/services/citgraph.service';

/**
 * Contract a k-hop citation graph onto a "retrieved" subset of its nodes.
 *
 * `isRetained(backendId)` returns the *output* node id for a retained
 * (retrieved) backend node, or undefined for an intermediate. The returned
 * edges are in the OUTPUT id space (whatever isRetained returns), directed
 * source→target, de-duplicated, no self-loops.
 *
 * An output edge A→B is emitted iff there is a directed path A → i1 → … → in → B
 * in `edges` where every interior node ik is NOT retained (B is the first
 * retained node reached). Direct A→B (n=0 interior nodes) is included.
 */
export function contractMultiHopEdges(
  nodes: CitGraphNode[],
  edges: CitGraphEdge[],
  isRetained: (backendId: string) => string | undefined,
): CitGraphEdge[];
```

Algorithm:
- Build a directed adjacency `Map<string, string[]>` from `edges` over the node
  id space (source → [targets]). Ignore edges whose endpoints are absent from
  `nodes` (defensive).
- For each retained node `A` (backend id `a`, output id `oa = isRetained(a)`):
  - DFS/BFS from `a`'s out-neighbours with a per-source `visited` set.
  - On reaching `x`: if `isRetained(x)` is defined → it's a boundary: emit output
    edge `oa → isRetained(x)` (skip if equal to `oa`), do **not** expand past it.
    Else (intermediate) → push its out-neighbours.
- De-dup output edges by `` `${source}\t${target}` `` ; drop self-loops.

Cost note: O(R · (V+E)) worst case. With `K_HOPS = 2` and the per-paper top-K
caps the intermediate layer is bounded, so this is acceptable. (Possible later
optimisation: a single multi-source pass, or weighting edges by path count.)

## Component change
File: `frontend/src/app/features/okgraph/okgraph.component.ts`,
method `exploreSurrounding(direction)`.

Replace the synchronous client-only `if (!this.useOnlySelected()) { … }` block
(currently builds edges from each paper's `references`/`referenced_by` and returns)
with an **async backend-expansion + contraction** path:

1. Keep the existing retrieved-node construction: build `nodes: CitGraphNode[]`
   from `seeds` (the filtered retrieved papers) — these stay the OUTPUT nodes, in
   client `paperId` space, so **all** retrieved papers remain visible even if the
   backend can't resolve some (they simply end up edgeless → Miscellaneous).
2. Keep the existing `identifierToId` map (client doi/arxiv/s2/openalex/pubmed →
   client `paperId`).
3. Issue `citgraphSvc.explore` / `exploreDemo` (mirror the demo switch used by the
   seed path) with a **structure-only** request so intermediates are pure
   connectors and are never dropped by a filter:
   ```
   paper_ids: seedIds,
   direction,
   include_non_matching: true,
   keywords: [],
   boolean_query: '',
   node_filter: null,
   k: kHops,               // = ADMIN_GRAPH_CONFIG.all.K_HOPS (now 2)
   max_per_hop: maxPerHop,
   top_k_per_paper: topKPerPaper,
   influential_only: INFLUENTIAL_CITATIONS_ONLY,
   directional_split: false,
   ```
4. Reuse the seed path's fake-progress interval + `exploreSub` subscription
   machinery (factor out or duplicate minimally).
5. In `next(res)`:
   - Build `clientIdOf(backendId)`: for each `res.nodes` node, try its identifiers
     in priority order — `paper_id` (S2 corpusid), `doi`, `arxiv_id` — lower-cased
     against `identifierToId`; first hit → client `paperId`. Cache as
     `Map<string,string>`. A node maps iff it is a retrieved paper (these are the
     `hop === 0` seeds that resolved). Define
     `isRetained = (id) => clientToId.get(id)`.
   - `const finalEdges = contractMultiHopEdges(res.nodes, res.edges, isRetained);`
   - `const finalNodes = nodes;` (the client retrieved nodes from step 1).
   - **No** `seedsOnlyGuardMessage` — in `all` mode retrieved-only is the point.
   - Louvain over `finalNodes` + `finalEdges` (re-index edges via `indexOf`), set
     progress phases (clustering 35 → summarizing 45) exactly as the seed path.
   - `setHierarchy({ nodes: finalNodes, louvain, edges: finalEdges,
     resolution, maxLevels: 10, keywords, booleanQuery, seedId: '',
     prefiltered: booleanQuery.length > 0, initialSeedIds: [],
     directionalSplit: false })`.
   - Success toast with `finalNodes.length`.
   - `error`: same handler as the seed path.

Notes / invariants:
- `booleanQuery`/`keywords` come from the existing computed/parse logic; the
  filter still gates which retrieved papers become `nodes` (the up-front
  `seeds = rawSeeds.filter(keep)`), but is **not** sent to the backend (so
  intermediate connectors aren't filtered away). Matches today's `all`
  prefilter semantics (`prefiltered = booleanQuery.length > 0`).
- `seedId: ''` and `initialSeedIds: []` — `all` mode has no distinguished seed,
  same as the old client path.

## Update (post-implementation correction)
First cut walked the contraction **directed** (source cites target) and passed the
seed-mode `direction` through. In practice same-query results are siblings linked
by co-citation / bibliographic coupling, not directed citation chains, so ~2/3 of
nodes came back disconnected. Corrected to:
- **Undirected contraction**: each citation edge is walked both ways, so `A→F`,
  `B→F` (coupling) and `G→A`, `G→B` (co-citation) connect A and B. Output edges
  are unordered pairs; orientation is incidental. ≈ shortest-path connectivity.
- **Directionless backend fetch**: `all` forces `direction: 'both'` (ignores the
  past/future toggle) with `directional_split: false` (v1 mixed traversal), so a
  frontier paper expands both ways each hop — e.g. the references of a citer are
  reachable. Seed mode's `direction` / v2 cones are unchanged.

## Test / verify
- `npx tsc --noEmit` clean.
- Unit test of `contractMultiHopEdges` (subtask 03).
- Manual smoke (frontend): run a search, switch the build panel to **All**, press
  Explore; confirm a graph builds, only retrieved papers appear as nodes, and
  edges/clusters render. (End-to-end not required per CLAUDE.md for this size.)
```
