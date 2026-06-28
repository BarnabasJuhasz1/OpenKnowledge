# ok-graph 'all' mode multi-hop — 01: config K_HOPS

## Goal
Lower the citation-neighbourhood depth used by the OK-Graph **`all`** construction
mode from 4 to 2. `all` mode now sends *every* retrieved paper to the backend
`/explore` expansion (see subtask 02), so a depth-4 expansion from hundreds of
seeds risks BigQuery cost blow-ups and timeouts. Depth 2 already links any two
retrieved papers that share an intermediate citation (retrieved → intermediate →
retrieved), which is the minimum needed for the multi-hop feature to do anything
beyond direct citations.

## File
`frontend/src/app/core/config/admin-graph-config.ts`

## Changes
1. In `ADMIN_GRAPH_CONFIG.all`, set `K_HOPS: 2` (was `4`).
2. Update the `GraphBuildMode` doc comment for `'all'`: it no longer says only
   `RESOLUTION` applies. In the new design `K_HOPS`, `MAX_PER_HOP` and
   `TOP_K_PER_PAPER` drive the backend k-hop expansion that the multi-hop edge
   contraction is derived from; `RESOLUTION` still drives Louvain over the
   contracted retrieved-only graph.
3. Leave `ADMIN_GRAPH_CONFIG_V2.all` untouched — v2 is seed-mode only and its
   `all` entry is never consulted (kept for symmetry).

## Test / verify
- Type-check only (`npx tsc --noEmit` via the lint/build). No behavioural test;
  the value is exercised by subtask 02's build path.
```
