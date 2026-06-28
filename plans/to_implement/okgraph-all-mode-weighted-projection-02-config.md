# ok-graph 'all' mode — weighted projection (02: config surface)

## Goal
Expose the projection as a **selectable clustering substrate** for `'all'` mode,
keeping the existing full-graph path intact so the two can be A/B compared on a
real query before committing to either. The k-hop expansion params
(`K_HOPS` / `MAX_PER_HOP` / `TOP_K_PER_PAPER`) are unchanged — the projection
reuses the same fetched neighbourhood; only how edges are built for Louvain
changes.

## File
`frontend/src/app/core/config/admin-graph-config.ts`

### Add a mode switch + projection params
Add to the config interface (near `RESOLUTION`, `admin-graph-config.ts:35`):

```ts
/** 'all' mode clustering substrate:
 *   'full-graph' (current) — cluster retrieved + intermediate nodes, hide
 *                            intermediates after. Fragments retrieved papers.
 *   'projection'           — cluster a weighted similarity graph over the
 *                            retrieved papers only; edge weight = shared
 *                            intermediate connectors (co-citation/coupling).
 *  Only consulted for the 'all' build; 'seed' mode ignores it. */
ALL_CLUSTER_SUBSTRATE: 'full-graph' | 'projection';

/** Projection-only knobs (ignored when substrate is 'full-graph').
 *  See weighted-projection.ts. */
PROJECTION_MIN_WEIGHT: number;            // density / Miscellaneous dial
PROJECTION_HUB_DISCOUNT: 'none' | 'inverse-degree' | 'adamic-adar';
PROJECTION_DIRECT_EDGE_BONUS: number;
```

### Defaults
Set on the **`all`** entry of both `ADMIN_GRAPH_CONFIG` (v1) and the v2 config
object, matching the existing structure (`admin-graph-config.ts:74-89`):

```ts
ALL_CLUSTER_SUBSTRATE: 'projection',
PROJECTION_MIN_WEIGHT: 1,
PROJECTION_HUB_DISCOUNT: 'adamic-adar',
PROJECTION_DIRECT_EDGE_BONUS: 1,
```

Keep `RESOLUTION: 0.5` as-is for now — with the projection the graph is ~75 nodes
instead of thousands, so resolution behaves more predictably; tune during
subtask-03 verification if clusters still come out too fine/coarse.

The `seed` entries do **not** need the projection keys read, but to keep one
interface they should carry harmless defaults (`ALL_CLUSTER_SUBSTRATE:
'full-graph'` is fine there since the seed path never reads it). Decide: either
make the new fields optional (`?`) on the interface so only the `all` entries set
them, **or** fill every entry. Prefer **optional fields** to avoid noise on the
seed/v2 entries — the build path reads them with defaults anyway.

## Verify
- `npx tsc --noEmit -p tsconfig.app.json` clean (all config literals satisfy the
  interface).
