/**
 * v2-only ("direction-pure cones") layout helper: split a year column that holds
 * a seed paper so the seed never shares its vertical column with non-seed papers.
 *
 * A seed's year is divided into ordered sub-columns, read left → right by citation
 * direction so same-year neighbours sit on the correct side of the seed:
 *
 *     [ other | refs | SEED | citers ]
 *
 *   - `refs`   non-seed same-year papers the seed CITES (references; "before").
 *   - `citers` non-seed same-year papers that CITE the seed ("after").
 *   - `other`  same-year non-seed papers with no clean single relation to a seed
 *              (unrelated, or both-directions/conflicting) — their own neutral
 *              column, kept visually distinct from real references.
 *   - `seed`   the seed paper(s); the reserved middle-right column.
 *
 * Edge convention matches the backend (`citgraph_builder.py`): `source → target`
 * means *source cites target*. So an edge `(seed, P)` makes P a reference of the
 * seed (left), and `(P, seed)` makes P a citer (right).
 *
 * "Only when needed": a seed year is split (and therefore widened by the layout)
 * ONLY when it also contains a non-seed paper. A seed alone in its year keeps a
 * single normal-width column.
 *
 * Ids are in the paper_id / edge space (`PlacedNode.id`), so node ids and edge
 * endpoints match directly. Seed-ness is decided by the caller and passed in.
 * Each node here is a placed cluster *representative* paper; classification uses
 * that rep's citation edges — exact at the leaf (per-paper) view, a reasonable
 * proxy at coarser cluster views.
 *
 * Pure (no Angular / DOM) so it is unit-tested on plain arrays; the component maps
 * the result onto sub-column x positions.
 */

export type SeedRole = 'other' | 'refs' | 'seed' | 'citers';

/** Left → right order of the sub-columns within a split year. */
export const SEED_ROLE_ORDER: readonly SeedRole[] = ['other', 'refs', 'seed', 'citers'];

export interface SeedSplitNode {
  /** paper_id / edge-space id (PlacedNode.id). */
  id: string;
  year: number;
  isSeed: boolean;
}

/** Citation edge in paper_id form; `source` cites `target`. */
export interface SeedSplitEdge {
  source: string;
  target: string;
}

export interface SeedYearSplit {
  /**
   * Ordered active sub-columns per year, for the years that are actually split
   * (≥ 2 active roles). Years absent here render as a single normal column.
   */
  rolesByYear: Map<number, SeedRole[]>;
  /**
   * Role per node id, for every node that lives in a split year (seeds → 'seed').
   * Nodes in non-split years are absent (they use the column centre).
   */
  roleOf: Map<string, SeedRole>;
}

export function computeSeedYearSplit(
  nodes: SeedSplitNode[],
  edges: SeedSplitEdge[],
): SeedYearSplit {
  const rolesByYear = new Map<number, SeedRole[]>();
  const roleOf = new Map<string, SeedRole>();

  // Seed ids per year, and the year each node lives in.
  const seedIdsByYear = new Map<number, Set<string>>();
  const yearOf = new Map<string, number>();
  for (const n of nodes) {
    yearOf.set(n.id, n.year);
    if (n.isSeed) {
      let s = seedIdsByYear.get(n.year);
      if (!s) { s = new Set(); seedIdsByYear.set(n.year, s); }
      s.add(n.id);
    }
  }
  if (seedIdsByYear.size === 0) return { rolesByYear, roleOf };

  // Per node: is it a same-year reference of a seed, and/or a same-year citer?
  // Only edges where exactly one endpoint is a same-year seed contribute.
  const isRef = new Set<string>();    // node cited BY a same-year seed (seed → node)
  const isCiter = new Set<string>();  // node that CITES a same-year seed (node → seed)
  for (const e of edges) {
    const sy = yearOf.get(e.source);
    const ty = yearOf.get(e.target);
    if (sy === undefined || ty === undefined || sy !== ty) continue;
    const seeds = seedIdsByYear.get(sy);
    if (!seeds) continue;
    const sSeed = seeds.has(e.source);
    const tSeed = seeds.has(e.target);
    // seed → target : target is a reference of the seed.
    if (sSeed && !tSeed) isRef.add(e.target);
    // source → seed : source is a citer of the seed.
    if (tSeed && !sSeed) isCiter.add(e.source);
  }

  // Classify every node that lives in a seed year, then keep only years that
  // genuinely need splitting (a seed plus at least one non-seed neighbour).
  const byYear = new Map<number, { id: string; role: SeedRole }[]>();
  for (const n of nodes) {
    if (!seedIdsByYear.has(n.year)) continue;
    let role: SeedRole;
    if (n.isSeed) {
      role = 'seed';
    } else {
      const ref = isRef.has(n.id);
      const cite = isCiter.has(n.id);
      role = ref && !cite ? 'refs' : cite && !ref ? 'citers' : 'other';
    }
    let arr = byYear.get(n.year);
    if (!arr) { arr = []; byYear.set(n.year, arr); }
    arr.push({ id: n.id, role });
  }

  for (const [year, members] of byYear) {
    const present = new Set(members.map(m => m.role));
    const active = SEED_ROLE_ORDER.filter(r => present.has(r));
    if (active.length < 2) continue;   // only the seed → nothing to split
    rolesByYear.set(year, active);
    for (const m of members) roleOf.set(m.id, m.role);
  }

  return { rolesByYear, roleOf };
}
