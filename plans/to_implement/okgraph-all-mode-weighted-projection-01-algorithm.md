# ok-graph 'all' mode — weighted projection (01: projection algorithm)

## Background / why
`'all'` mode currently clusters the **full** k-hop graph (retrieved papers +
hidden intermediate connectors) and then hides the intermediates
(`okgraph.component.ts:773` build, `hideIntermediates` in
`okgraph-state.service.ts:177`). Because the partition is shaped by the thousands
of intermediate nodes, retrieved papers scatter across many top-level
communities — producing ~49 clusters from 75 papers, many of them single-paper
(a community whose only hop-0 member is that one paper).

The earlier approach — clustering retrieved papers by their **direct** citation
edges to each other — failed the opposite way: retrieved papers almost never cite
each other directly, so nearly every node was degree-0 and fell into
Miscellaneous (`louvain.ts:53`).

Both are symptoms of the same fact: **retrieved papers connect to each other only
*through* intermediates.** This subtask builds the middle path — a **weighted
similarity projection** onto the retrieved papers, where edge weight comes from
*shared intermediate neighbours* (co-citation / bibliographic coupling), not
direct citations. Louvain then optimizes over the ~75 papers we care about, and
genuinely unrelated papers still fall to Miscellaneous — but far fewer than the
direct-edge version, because most papers share *some* connector.

This subtask is the **pure algorithm only** (no wiring). It must stay free of
Angular/signal deps so it is unit-testable on plain arrays (same convention as
`cluster-ops.ts`).

## New file
`frontend/src/app/features/okgraph/weighted-projection.ts`

### Inputs (the unified index space the build already produces)
The `'all'` build already creates a single index space over
`fullNodes = [...nodes, ...intermediateNodes]` where the **retained** papers are
indices `0 .. retainedCount-1` (they are prepended), and `mappedEdges` are the
full-graph undirected edges in that space (`okgraph.component.ts:744-771`). The
projection consumes exactly that:

```ts
export type HubDiscount = 'none' | 'inverse-degree' | 'adamic-adar';

export interface ProjectionOptions {
  /** Drop projected edges whose final weight is below this. The primary
   *  density / Miscellaneous dial. Default 1 (keep any shared neighbour). */
  minWeight?: number;
  /** Down-weight popular connectors so a few hub intermediates don't tie
   *  everything together. Default 'adamic-adar'. */
  hubDiscount?: HubDiscount;
  /** Add a fixed bonus to a pair that ALSO has a direct retained↔retained edge,
   *  so the rare direct citation still counts (and counts strongly). Default 1. */
  directEdgeBonus?: number;
}

export interface ProjectionEdge { source: number; target: number; weight: number; }

/** Weighted similarity graph over the retained papers (indices 0..retainedCount-1).
 *  `edges` are the FULL k-hop graph edges in the same index space; intermediates
 *  are indices >= retainedCount. Output edges use the SAME retained indices, so the
 *  result feeds straight into `louvain(retainedCount, edges, ...)`. */
export function buildRetrievedProjection(
  retainedCount: number,
  fullNodeCount: number,
  edges: readonly { source: number; target: number }[],
  options?: ProjectionOptions,
): ProjectionEdge[];
```

### Algorithm
1. **Build undirected adjacency** over the full node set from `edges` (skip
   self-loops; de-dup is already done upstream but tolerate dupes). Track each
   node's degree.
2. **Direct retained↔retained edges**: when both endpoints `< retainedCount`,
   record the unordered pair so the `directEdgeBonus` can be added later. (These
   are rare but real.)
3. **Co-citation projection** — iterate every node `s` (intermediate *or*
   retained) and collect its **retained** neighbours `R(s) = { n ∈ adj(s) : n < retainedCount }`.
   For every unordered pair `(i, j)` within `R(s)`, add a contribution:
   - `'none'`            → `+1`
   - `'inverse-degree'`  → `+ 1 / deg(s)`
   - `'adamic-adar'`     → `+ 1 / log(1 + deg(s))`  (with a guard so `deg(s) <= 1`
     contributes 0 — a connector linking only one retained paper relates nothing).
   Accumulate into a `Map<"i,j", number>` (i < j).
   - Complexity is `Σ_s |R(s)|²`. For ~75 retained papers and connectors that each
     touch a handful of them this is tiny; still, if `|R(s)|` is huge for a hub,
     the inverse-degree / adamic-adar discount already makes those pairs cheap —
     no extra cap needed at this scale.
4. **Add `directEdgeBonus`** to each pair that had a direct edge (step 2).
5. **Threshold + emit**: drop pairs with accumulated weight `< minWeight`; emit
   the rest as `ProjectionEdge`s. Retained papers that share no qualifying
   neighbour and have no direct edge appear in **no** projected edge → they are
   degree-0 in the projection → `louvain()` correctly routes them to
   Miscellaneous.

### Notes
- Output node id space is the retained indices `0..retainedCount-1` directly, so
  `nodes` (the retained `CitGraphNode[]`) stay the base nodes 1:1 — **no**
  intermediates in the clustered set, so `hideIntermediates` is **not** needed in
  this mode (subtask 03).
- Weighted edges are first-class in `louvain()` (it reads `e.weight`,
  `louvain.ts:41`) and in `_modularity` — nothing to change there.

## Tests
New `frontend/src/app/features/okgraph/weighted-projection.spec.ts`:
- Two retained papers sharing 3 intermediate connectors, none shared with a third
  → edge (1,2) present with the expected weight; node 3 isolated.
- A hub connector touching all retained papers contributes little under
  `'adamic-adar'`/`'inverse-degree'` vs `'none'` (assert ordering of weights).
- `directEdgeBonus` lifts a directly-citing pair above a `minWeight` that would
  otherwise drop it.
- `minWeight` raised → sparser graph, more isolated nodes (Miscellaneous dial).
- A connector with only one retained neighbour produces no edge.

## Verify
- `npx vitest run weighted-projection`
- `npx tsc --noEmit -p tsconfig.app.json` clean.
