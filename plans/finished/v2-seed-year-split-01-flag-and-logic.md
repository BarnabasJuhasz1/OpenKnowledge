# v2 seed-year split — 01 · v2 flag + pure sub-column logic

Feature (v2 graphs only): a seed paper must never share its vertical year column
with non-seed papers. A year column that holds a seed is split into ordered
sub-columns so the seed sits alone and same-year neighbours read left→right by
citation direction:

```
[ other | refs | SEED | citers ]
```

- `refs`   — non-seed same-year papers the seed **cites** (references; "before").
- `citers` — non-seed same-year papers that **cite** the seed ("after").
- `other`  — same-year non-seed papers with no clean single relation to a seed
             (unrelated, or both-directions/conflicting). Own neutral column.
- `SEED`   — the seed paper(s); always the reserved middle-right column.

Edge convention (confirmed `citgraph_builder.py:440`): `source → target` ==
**source cites target**. So an edge `(seed, P)` ⇒ P is a reference (left); an edge
`(P, seed)` ⇒ P is a citer (right).

"Only when needed": a seed year is widened **only** when it contains a non-seed
paper. A seed year with no other same-year papers stays single-width.

## 1. Thread a `directionalSplit` (v2) flag to the layout

The displayed graph must know it was built as v2 (the live `graphVersion` signal
is the *next* build's intent, not the current graph's). Add an explicit flag.

- `okgraph-state.service.ts`:
  - Add `directionalSplit?: boolean` to `HierarchyPayload`.
  - Add `readonly directionalSplit = signal(false);`
  - In `setHierarchy`: `this.directionalSplit.set(!!p.directionalSplit);`
  - In `clear()`: reset to `false`.
- `okgraph.component.ts` — set the flag on both `setHierarchy` payloads:
  - seed path (post-explore subscribe): `directionalSplit: splitV2`
  - client-side `'all'` path: `directionalSplit: false` (v2 is seed-mode only).
  - `splitV2` already exists in `exploreSurrounding` scope (the v2 config guard);
    it is in closure scope of the subscribe callback.

## 2. Pure module `seed-year-split.ts`

Layout-agnostic, unit-tested on plain arrays. All ids are in the **paper_id /
edge** space (`PlacedNode.id`), so edges and node ids match directly. Seed-ness is
decided by the caller and passed in as `isSeed`.

```ts
export type SeedRole = 'other' | 'refs' | 'seed' | 'citers';
export const SEED_ROLE_ORDER: SeedRole[] = ['other', 'refs', 'seed', 'citers'];

export interface SeedSplitNode { id: string; year: number; isSeed: boolean; }
export interface SeedSplitEdge { source: string; target: string; } // source cites target

export interface SeedYearSplit {
  /** Ordered active sub-columns per year — ONLY years that are actually split
   *  (≥2 active roles). Years absent here render as a single normal column. */
  rolesByYear: Map<number, SeedRole[]>;
  /** Role per node id, for every node that lives in a split year (seeds → 'seed'). */
  roleOf: Map<string, SeedRole>;
}

export function computeSeedYearSplit(
  nodes: SeedSplitNode[], edges: SeedSplitEdge[],
): SeedYearSplit;
```

Algorithm:
1. `seedIdsByYear: Map<year, Set<id>>` over seed nodes. Seed years = its keys.
2. Adjacency restricted to relevant ids: for each edge, if `source` is a seed in
   year Y and `target` is a (non-seed) node in the same year Y → mark target
   `isRef`; if `target` is a seed in year Y and `source` a node in year Y → mark
   source `isCiter`. (Build `out`/`in` neighbour sets keyed by id for O(E).)
3. Classify each node in a seed year:
   - seed → `'seed'`.
   - non-seed: `isRef && !isCiter` → `'refs'`; `isCiter && !isRef` → `'citers'`;
     else → `'other'` (covers unrelated AND both-directions conflict).
4. Per seed year, `active = SEED_ROLE_ORDER.filter(r => some node has it)`. Emit to
   `rolesByYear` only when `active.length >= 2` (else nothing to split). Emit
   `roleOf` for nodes only in emitted (split) years.

Note: at coarse cluster views a placed node is a cluster *representative* paper;
classification uses that rep paper's edges (exact at the leaf level, a reasonable
proxy above). Document this in the module header.

## Tests (`seed-year-split.spec.ts`)
- seed cites same-year P → year split `['refs','seed']`, P→refs, seed→seed.
- seed cited-by same-year Q → `['seed','citers']`.
- both → `['refs','seed','citers']` (3×); unrelated U present → adds `'other'` →
  `['other','refs','seed','citers']`.
- seed alone in its year (no other same-year nodes) → NOT in `rolesByYear`.
- non-seed years (no seed) → never split.
- conflict (P cited by seedA and cites seedB, same year) → `'other'`.
