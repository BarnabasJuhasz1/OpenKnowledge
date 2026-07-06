import { Paper } from '../../core/models/paper.model';

/**
 * Year-distributed graph layout, extracted from the Graph view so other views
 * (e.g. OK-Graph) can reuse the exact same look. Unlike the Graph component
 * (which derives adjacency from paper references), this takes an explicit edge
 * list, so it can lay out any node/edge set.
 */

export interface LayoutItem {
  id: string;
  paper: Paper;
  year: number;
}

export interface LaidOutNode extends LayoutItem {
  x: number;
  y: number;
  letter: string;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
  // True when at least one underlying citation merged into this (possibly
  // cluster-aggregated) link is an S2 "highly influential" citation. Absent on
  // non-citation links (e.g. manual expansion lineage).
  isInfluential?: boolean;
}

export interface YearColumn {
  year: number;
  x: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LayoutEdge[];
  yearColumns: YearColumn[];
  dividers: { x: number }[];
  width: number;
  height: number;
}

export const NODE_RADIUS = 22;
const YEAR_GAP = 180;
const VERTICAL_GAP = 90;
export const TOP_PADDING = 60;
const LEFT_PADDING = 80;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function layoutByYear(items: LayoutItem[], edges: LayoutEdge[]): GraphLayout {
  const withYear = items.filter(it => it.year != null);

  const years = [...new Set(withYear.map(it => it.year))].sort((a, b) => a - b);
  const yearColumns: YearColumn[] = years.map((year, i) => ({
    year,
    x: LEFT_PADDING + i * YEAR_GAP,
  }));
  const yearX = new Map(yearColumns.map(c => [c.year, c.x]));

  const nodes: LaidOutNode[] = withYear.map((it, i) => ({
    ...it,
    letter: i < LETTERS.length ? LETTERS[i] : `${i + 1}`,
    x: yearX.get(it.year) ?? LEFT_PADDING,
    y: 0,
  }));

  // Group nodes by year column.
  const byYear = new Map<number, LaidOutNode[]>();
  for (const n of nodes) {
    let arr = byYear.get(n.year);
    if (!arr) { arr = []; byYear.set(n.year, arr); }
    arr.push(n);
  }

  // Build adjacency from the explicit edges (only between known nodes).
  const known = new Set(nodes.map(n => n.id));
  const adj = new Map<string, Set<string>>();
  const validEdges: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.fromId) || !known.has(e.toId) || e.fromId === e.toId) continue;
    const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validEdges.push(e);
    if (!adj.has(e.fromId)) adj.set(e.fromId, new Set());
    if (!adj.has(e.toId)) adj.set(e.toId, new Set());
    adj.get(e.fromId)!.add(e.toId);
    adj.get(e.toId)!.add(e.fromId);
  }

  // Initial vertical stacking within each column.
  for (const [, col] of byYear) {
    col.forEach((n, i) => { n.y = TOP_PADDING + 40 + i * VERTICAL_GAP; });
  }

  // Barycentric ordering: pull each node toward the mean y of its cross-column
  // neighbours, then restack. A few sweeps reduce edge crossings.
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const ITERATIONS = 4;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const yearOrder = iter % 2 === 0 ? years : [...years].reverse();
    for (const yr of yearOrder) {
      const col = byYear.get(yr);
      if (!col || col.length < 2) continue;
      for (const n of col) {
        const neighbors = adj.get(n.id);
        if (!neighbors || neighbors.size === 0) continue;
        let sum = 0, count = 0;
        for (const nid of neighbors) {
          const nb = nodeById.get(nid);
          if (nb && nb.year !== yr) { sum += nb.y; count++; }
        }
        if (count > 0) n.y = sum / count;
      }
      col.sort((a, b) => a.y - b.y);
      col.forEach((n, i) => { n.y = TOP_PADDING + 40 + i * VERTICAL_GAP; });
    }
  }

  const dividers: { x: number }[] = [];
  for (let i = 0; i < yearColumns.length - 1; i++) {
    dividers.push({ x: (yearColumns[i].x + yearColumns[i + 1].x) / 2 });
  }

  const width = yearColumns.length > 0
    ? yearColumns[yearColumns.length - 1].x + LEFT_PADDING + 40
    : 400;
  const height = nodes.length
    ? Math.max(...nodes.map(n => n.y)) + VERTICAL_GAP + 20
    : 300;

  return { nodes, edges: validEdges, yearColumns, dividers, width, height };
}

/**
 * Order the highest-level cluster lanes (top → bottom) so the merge bridges
 * drawn between connected clusters overlap as little as possible.
 *
 * The previous ordering was by descending cluster size alone, independent of how
 * clusters connect, so bridges often spanned many lanes and crossed. This instead
 * lays lanes out from the connectivity of the cluster graph:
 *   - the most-connected cluster (highest total bridge weight) is seeded near the
 *     middle lane,
 *   - clusters are then pulled toward the mean lane of their connected neighbours
 *     (weighted barycentre seriation), so a single-connection cluster ends up
 *     adjacent to its one neighbour and tightly-linked clusters sit together,
 *   - clusters with no bridges (incl. the Miscellaneous group) carry no crossing
 *     cost, so they are parked at the bottom by descending size, Miscellaneous
 *     always last.
 *
 * `pairWeight` is keyed by the unordered top-cluster pair `"min|max"` → number of
 * citation edges joining the two clusters (Miscellaneous excluded upstream,
 * exactly as the bridges are derived).
 */
export function orderLanesByConnectivity(
  clusters: number[],
  pairWeight: Map<string, number>,
  sizeOf: Map<number, number>,
  misc: number | null,
): number[] {
  const sizeDesc = (a: number, b: number) =>
    ((sizeOf.get(b) ?? 0) - (sizeOf.get(a) ?? 0)) || (a - b);

  // Weighted cluster adjacency + degree from the bridge pair weights.
  const adj = new Map<number, Map<number, number>>();
  const deg = new Map<number, number>();
  for (const c of clusters) { adj.set(c, new Map()); deg.set(c, 0); }
  for (const [key, w] of pairWeight) {
    if (w <= 0) continue;
    const [a, b] = key.split('|').map(Number);
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + w);
    adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + w);
    deg.set(a, deg.get(a)! + w);
    deg.set(b, deg.get(b)! + w);
  }

  const connected = clusters.filter(c => (deg.get(c) ?? 0) > 0);
  const isolated = clusters.filter(c => (deg.get(c) ?? 0) === 0).sort(sizeDesc);
  // Miscellaneous (if present) always last among the isolated lanes.
  if (misc != null) {
    const i = isolated.indexOf(misc);
    if (i >= 0) { isolated.splice(i, 1); isolated.push(misc); }
  }

  if (connected.length <= 1) return [...connected, ...isolated];

  // Connected components of the bridge graph: bridges never join two different
  // components, so laying each component out as one contiguous block of lanes is
  // crossing-free between components — only the order *within* a component and
  // the order *of* the components matter.
  const seenC = new Set<number>();
  const components: number[][] = [];
  for (const start of connected) {
    if (seenC.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seenC.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      for (const d of adj.get(c)!.keys()) {
        if (!seenC.has(d)) { seenC.add(d); stack.push(d); }
      }
    }
    components.push(comp);
  }

  // Hub-centred seriation of a single component:
  //   - seed a hub-centred order: strongest cluster in the middle, the rest
  //     fanned out alternately above/below it,
  //   - then run weighted barycentre sweeps — pull each cluster toward the mean
  //     lane of its neighbours and re-rank to integer lanes. Re-ranking each
  //     sweep keeps the coordinates spread out (a plain repeated average on a
  //     connected graph would collapse them all to the mean).
  const seriate = (members: number[]): number[] => {
    if (members.length <= 1) return members.slice();
    const byDeg = [...members].sort(
      (a, b) => (deg.get(b)! - deg.get(a)!) || sizeDesc(a, b),
    );
    const hi: number[] = [];
    const lo: number[] = [];
    byDeg.forEach((c, i) => (i % 2 === 0 ? lo : hi).push(c));
    const order = [...hi.reverse(), ...lo];

    const SWEEPS = 12;
    let coord = new Map(order.map((c, i) => [c, i]));
    for (let s = 0; s < SWEEPS; s++) {
      const next = new Map(coord);
      for (const c of order) {
        const nb = adj.get(c)!;
        let sum = 0, wsum = 0;
        for (const [d, w] of nb) { sum += w * coord.get(d)!; wsum += w; }
        if (wsum > 0) next.set(c, sum / wsum);
      }
      order.sort((a, b) => (next.get(a)! - next.get(b)!) || (coord.get(a)! - coord.get(b)!));
      coord = new Map(order.map((c, i) => [c, i]));
    }
    return order;
  };

  // Order the components: the most-connected component (largest internal bridge
  // weight) sits in the middle, the rest fanned out around it — so the overall
  // hub cluster lands near the centre lane.
  const compWeight = (comp: number[]) => comp.reduce((s, c) => s + deg.get(c)!, 0);
  const byWeight = [...components].sort(
    (a, b) => (compWeight(b) - compWeight(a)) || (b.length - a.length),
  );
  const cHi: number[][] = [];
  const cLo: number[][] = [];
  byWeight.forEach((comp, i) => (i % 2 === 0 ? cLo : cHi).push(comp));
  const orderedComps = [...cHi.reverse(), ...cLo];

  const result: number[] = [];
  for (const comp of orderedComps) result.push(...seriate(comp));
  return [...result, ...isolated];
}

/** Minimal placed-node shape the citation-link derivation needs. */
export interface PlacedRef {
  id: string;
  /** Base-node index this node represents (its cluster representative). */
  repIndex: number;
  /** Hierarchy level the node represents (-1 = an individual leaf paper). */
  level: number;
  /** Community id at `level` the node represents. */
  community: number;
}

/**
 * Derive the links to draw between placed nodes from the REAL citation edges,
 * so a cluster shows its internal citation structure regardless of how its
 * papers were revealed (drilling in / "expand whole cluster" add no manual
 * links). Each base node is mapped to the finest placed node that represents it
 * in the current view; a citation edge whose two endpoints fall in the SAME
 * current-view cluster becomes one link between those placed nodes. Cross-cluster
 * edges are dropped by default — they are shown as blob bridges, not node links —
 * unless `includeCrossCluster` is set (cones graphs draw every citation as an edge).
 * Result is undirected and de-duplicated.
 *
 * @param placed              nodes currently on the canvas (already filtered).
 * @param rawEdges            citation edges in paper_id form (source cites target).
 * @param idxOf               paper_id -> base-node index.
 * @param currentComm         community id per base-node index at the view level.
 * @param communitiesAtLevel  community array for a hierarchy level (-1 = leaves).
 * @param baseCount           number of base nodes.
 * @param includeCrossCluster when true, also draw citation links whose endpoints
 *                            fall in different current-view clusters (default false).
 */
export function citationLinksBetweenPlaced(
  placed: PlacedRef[],
  rawEdges: { source: string; target: string; is_influential?: boolean }[],
  idxOf: Map<string, number>,
  currentComm: number[],
  communitiesAtLevel: (level: number) => number[],
  baseCount: number,
  includeCrossCluster = false,
): LayoutEdge[] {
  // Group placed nodes by level → (community -> placed id).
  const commByLevel = new Map<number, Map<number, string>>();
  for (const p of placed) {
    let m = commByLevel.get(p.level);
    if (!m) { m = new Map(); commByLevel.set(p.level, m); }
    m.set(p.community, p.id);
  }

  // Map each base node to the finest (lowest-level) placed node covering it.
  const baseToPlaced: (string | null)[] = new Array(baseCount).fill(null);
  const levelsFinestFirst = [...commByLevel.keys()].sort((a, b) => a - b);
  for (const lvl of levelsFinestFirst) {
    const m = commByLevel.get(lvl)!;
    const comm = communitiesAtLevel(lvl);
    for (let i = 0; i < baseCount; i++) {
      if (baseToPlaced[i] !== null) continue;
      const id = m.get(comm[i]);
      if (id !== undefined) baseToPlaced[i] = id;
    }
  }

  // Dedup undirected; a placed→placed link may aggregate several underlying
  // citations, so OR-in `isInfluential` across every contributor (influential
  // if any merged citation is influential).
  const byKey = new Map<string, LayoutEdge>();
  const edges: LayoutEdge[] = [];
  for (const e of rawEdges) {
    const u = idxOf.get(e.source);
    const v = idxOf.get(e.target);
    if (u == null || v == null) continue;
    if (!includeCrossCluster && currentComm[u] !== currentComm[v]) continue;   // intra-cluster only (unless cones)
    const fromId = baseToPlaced[u];
    const toId = baseToPlaced[v];
    if (!fromId || !toId || fromId === toId) continue;
    const key = fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (e.is_influential) existing.isInfluential = true;
      continue;
    }
    const edge: LayoutEdge = { fromId, toId, isInfluential: !!e.is_influential };
    byKey.set(key, edge);
    edges.push(edge);
  }
  return edges;
}

export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  if (Math.abs(dx) < 10) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }
  const cx = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${cx} ${from.y}, ${cx} ${to.y}, ${to.x} ${to.y}`;
}

/**
 * A gently rippling sine wave from ``from`` to ``to`` — used to mark influential
 * citation edges. The amplitude is tapered with sin(πt) so the wave flattens to
 * zero at both endpoints and meets the node circles cleanly.
 */
export function wavyEdgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;

  const ux = dx / len, uy = dy / len;   // direction
  const px = -uy, py = ux;              // perpendicular
  const WAVELENGTH = 28;               // px per full cycle
  const AMPLITUDE = 5;                 // px peak offset
  const cycles = Math.max(1, Math.round(len / WAVELENGTH));
  const steps = cycles * 12;           // segments (smoothness)

  let d = `M ${from.x.toFixed(1)} ${from.y.toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    // Land the final point exactly on `to` (sin(π) is not exactly 0 in floating
    // point, which would otherwise leave a sub-pixel kink at the endpoint).
    if (i === steps) {
      d += ` L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
      break;
    }
    const t = i / steps;
    const along = t * len;
    const taper = Math.sin(Math.PI * t);            // 0 at ends, 1 mid-edge
    const off = AMPLITUDE * taper * Math.sin(2 * Math.PI * cycles * t);
    const x = from.x + ux * along + px * off;
    const y = from.y + uy * along + py * off;
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}
