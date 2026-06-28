/**
 * Weighted similarity projection for OK-Graph 'all' mode.
 *
 * 'all' mode fetches a k-hop citation neighbourhood around the retrieved papers,
 * pulling in many *intermediate* connector papers. Clustering that full graph and
 * hiding the intermediates lets the connector structure fragment the retrieved
 * papers across dozens of communities (many holding a single retrieved paper).
 * Clustering the retrieved papers by their *direct* citations fails the opposite
 * way — they rarely cite each other, so almost all become disconnected and fall
 * into one "Miscellaneous" cluster.
 *
 * This builds the middle path: a weighted graph over the retrieved papers ONLY,
 * where two papers are linked by how much of their citation neighbourhood they
 * SHARE (co-citation / bibliographic coupling through the intermediates), rather
 * than by a direct citation. Louvain then optimises over the papers we actually
 * show, and only papers that share nothing with any other retained paper stay
 * disconnected → Miscellaneous.
 *
 * Pure (no Angular/signal deps) so it can be unit-tested on plain arrays, like
 * `cluster-ops.ts`.
 */

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
  /** Also link papers connected through a chain of TWO intermediates
   *  (`i → X → Y → j`, where X–Y is an intermediate↔intermediate edge), not just a
   *  shared single neighbour. Catches papers that sit in the same citation region
   *  but share no common neighbour — the chief source of an over-large
   *  Miscellaneous bucket. Each 2-hop bridge contributes
   *  `bridgeWeight · discount(deg X) · discount(deg Y)`, so long/hubby chains count
   *  for little and only papers bridged by several (or rare) chains cross
   *  `minWeight`. Default 0 (disabled — one-hop only). */
  bridgeWeight?: number;
}

export interface ProjectionEdge {
  source: number;
  target: number;
  weight: number;
}

/**
 * Weighted similarity graph over the retained papers (indices
 * `0 .. retainedCount-1`).
 *
 * `edges` are the FULL k-hop graph edges in a single index space where retained
 * papers occupy `0 .. retainedCount-1` and intermediate connectors occupy
 * `retainedCount .. fullNodeCount-1` (the layout the 'all' build already produces
 * by prepending the retained nodes). Output edges use the SAME retained indices,
 * so the result feeds straight into `louvain(retainedCount, edges, …)`.
 */
export function buildRetrievedProjection(
  retainedCount: number,
  fullNodeCount: number,
  edges: readonly { source: number; target: number }[],
  options: ProjectionOptions = {},
): ProjectionEdge[] {
  const minWeight = options.minWeight ?? 1;
  const hubDiscount: HubDiscount = options.hubDiscount ?? 'adamic-adar';
  const directEdgeBonus = options.directEdgeBonus ?? 1;
  const bridgeWeight = options.bridgeWeight ?? 0;

  if (retainedCount <= 1) return [];

  // Undirected adjacency + degree over the full node set. A node's neighbour set
  // is what defines its citation neighbourhood; the degree of a shared neighbour
  // drives the hub discount below.
  const adj = new Map<number, Set<number>>();
  const addAdj = (a: number, b: number) => {
    let s = adj.get(a);
    if (!s) { s = new Set(); adj.set(a, s); }
    s.add(b);
  };

  // Direct retained↔retained edges, recorded so the bonus can be applied later.
  // Keyed `i,j` with i < j (both < retainedCount).
  const directPairs = new Set<string>();
  const pairKey = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);

  for (const e of edges) {
    const { source: a, target: b } = e;
    if (a === b) continue;                                   // self-loop
    if (a < 0 || b < 0 || a >= fullNodeCount || b >= fullNodeCount) continue;
    addAdj(a, b);
    addAdj(b, a);
    if (a < retainedCount && b < retainedCount) directPairs.add(pairKey(a, b));
  }

  // Weight contributed per shared neighbour `s`, given its degree. A connector
  // touching only one retained paper relates nothing (it never forms a pair, so
  // it never reaches here with a usable degree, but guard anyway).
  const contribution = (degS: number): number => {
    if (degS <= 1) return 0;
    switch (hubDiscount) {
      case 'none':           return 1;
      case 'inverse-degree': return 1 / degS;
      case 'adamic-adar':    return 1 / Math.log(1 + degS);
    }
  };

  // Co-citation projection: for every node `s` (intermediate OR retained), every
  // unordered pair of its RETAINED neighbours shares `s`, so each such pair gets
  // `s`'s contribution. Σ_s |R(s)|² work — tiny at ~75 retained papers, and the
  // discount already makes high-degree hubs cheap.
  const weights = new Map<string, number>();
  for (const [s, neighbours] of adj) {
    const degS = neighbours.size;
    const c = contribution(degS);
    if (c === 0) continue;

    const retained: number[] = [];
    for (const n of neighbours) if (n < retainedCount) retained.push(n);
    if (retained.length < 2) continue;

    for (let x = 0; x < retained.length; x++) {
      for (let y = x + 1; y < retained.length; y++) {
        const key = pairKey(retained[x], retained[y]);
        weights.set(key, (weights.get(key) ?? 0) + c);
      }
    }
  }

  // 2-hop bridge pass: link papers connected as `i → X → Y → j` through an
  // intermediate↔intermediate edge X–Y (no shared single neighbour). For each
  // such edge, every retained neighbour of X pairs with every retained neighbour
  // of Y, contributing `bridgeWeight · discount(deg X) · discount(deg Y)` — so a
  // bridge through hubby or far-apart intermediates is cheap and only papers tied
  // by several (or rare) chains cross `minWeight`. Skipped entirely when disabled.
  if (bridgeWeight > 0) {
    const retainedOf = new Map<number, number[]>(); // memoised per intermediate
    const retainedNeighbours = (node: number): number[] => {
      let r = retainedOf.get(node);
      if (!r) {
        r = [];
        const nb = adj.get(node);
        if (nb) for (const n of nb) if (n < retainedCount) r.push(n);
        retainedOf.set(node, r);
      }
      return r;
    };

    const seenBridge = new Set<string>(); // each intermediate↔intermediate edge once
    for (const [x, neighbours] of adj) {
      if (x < retainedCount) continue;              // bridge endpoints are intermediates
      const cx = contribution(neighbours.size);
      if (cx === 0) continue;
      for (const y of neighbours) {
        if (y < retainedCount || y === x) continue; // need an intermediate↔intermediate edge
        const ek = x < y ? `${x},${y}` : `${y},${x}`;
        if (seenBridge.has(ek)) continue;
        seenBridge.add(ek);
        const cy = contribution(adj.get(y)!.size);
        if (cy === 0) continue;
        const w = bridgeWeight * cx * cy;
        if (w === 0) continue;

        const rx = retainedNeighbours(x);
        const ry = retainedNeighbours(y);
        if (!rx.length || !ry.length) continue;
        for (const i of rx) {
          for (const j of ry) {
            if (i === j) continue;                  // same paper on both ends of the chain
            const key = pairKey(i, j);
            weights.set(key, (weights.get(key) ?? 0) + w);
          }
        }
      }
    }
  }

  // Add the direct-edge bonus to any directly-citing retained pair (creates the
  // pair if shared neighbours didn't).
  if (directEdgeBonus !== 0) {
    for (const key of directPairs) {
      weights.set(key, (weights.get(key) ?? 0) + directEdgeBonus);
    }
  }

  // Threshold + emit. Pairs below `minWeight` are dropped; a retained paper left
  // in no surviving pair becomes degree-0 in the projection and so is routed to
  // Miscellaneous by louvain().
  const out: ProjectionEdge[] = [];
  for (const [key, w] of weights) {
    if (w < minWeight) continue;
    const [i, j] = key.split(',');
    out.push({ source: Number(i), target: Number(j), weight: w });
  }
  return out;
}
