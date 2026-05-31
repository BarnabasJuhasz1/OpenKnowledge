export interface LouvainResult {
  levels: number[][];
  communities: number[];
  modularity: number;
  /** Level-0 community id that holds every disconnected (degree-0) node, or
   *  null when the graph has none. Disconnected nodes are merged into this one
   *  "Miscellaneous" community instead of each surfacing as its own top-level
   *  cluster — which is what happens when filtering strips the edges that would
   *  otherwise tie them into the graph. `louvain()` always sets it; optional so
   *  older callers that build a result literal still type-check. */
  miscCommunity?: number | null;
}

export interface LouvainOptions {
  /** Resolution γ for the null-model term. >1 → more/smaller communities,
   *  <1 → fewer/larger communities. Default 1. */
  resolution?: number;
  /** Hard cap on the number of hierarchy levels produced. The algorithm stops
   *  once this many levels exist, even if a further pass would raise
   *  modularity. Default 20. */
  maxLevels?: number;
}

export function louvain(
  nodeCount: number,
  edges: { source: number; target: number; weight?: number }[],
  options: LouvainOptions = {},
): LouvainResult {
  const resolution = options.resolution && options.resolution > 0 ? options.resolution : 1;
  const maxLevels = options.maxLevels && options.maxLevels > 0 ? Math.floor(options.maxLevels) : 20;

  if (nodeCount === 0) {
    return { levels: [], communities: [], modularity: 0, miscCommunity: null };
  }

  const adj = new Map<number, Map<number, number>>();
  let totalWeight = 0;

  for (const e of edges) {
    if (e.source === e.target) continue;
    const w = e.weight ?? 1;
    if (!adj.has(e.source)) adj.set(e.source, new Map());
    if (!adj.has(e.target)) adj.set(e.target, new Map());
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) ?? 0) + w);
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) ?? 0) + w);
    totalWeight += w;
  }

  // Disconnected nodes (no incident edge). Filtering before clustering produces
  // a lot of these; left alone each stays a singleton at every level and so
  // surfaces as its own highest-level cluster. Collect them to merge into one
  // shared "Miscellaneous" community below.
  const isolated: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const nb = adj.get(i);
    if (!nb || nb.size === 0) isolated.push(i);
  }
  const miscSeed = isolated.length ? isolated[0] : -1;

  if (totalWeight === 0) {
    // No edges at all → every node is disconnected: one Miscellaneous cluster.
    const comm = new Array(nodeCount).fill(0);
    return { levels: [comm], communities: comm, modularity: 0, miscCommunity: 0 };
  }

  const m2 = totalWeight * 2;
  const community = Array.from({ length: nodeCount }, (_, i) => i);
  // Pre-merge every disconnected node into one community. Having no edges they
  // never move during the local passes, so they travel together up the whole
  // dendrogram and end as a single top-level cluster.
  for (const i of isolated) community[i] = miscSeed;
  const levels: number[][] = [];
  let miscCommunity: number | null = null;

  const kDeg = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const neighbors = adj.get(i);
    if (!neighbors) continue;
    for (const w of neighbors.values()) kDeg[i] += w;
  }

  let currentAdj = adj;
  let currentNodes = nodeCount;
  let currentKDeg = kDeg;
  let currentComm = community;
  let currentM2 = m2;

  for (let level = 0; level < maxLevels; level++) {
    let improved = true;
    let iterations = 0;

    const commDegrees = new Float64Array(currentNodes);
    for (let i = 0; i < currentNodes; i++) {
      commDegrees[currentComm[i]] += currentKDeg[i];
    }

    while (improved && iterations < 20) {
      improved = false;
      iterations++;

      for (let i = 0; i < currentNodes; i++) {
        const ci = currentComm[i];
        const ki = currentKDeg[i];
        const neighbors = currentAdj.get(i);
        if (!neighbors || neighbors.size === 0) continue;

        const commWeights = new Map<number, number>();
        let selfComm = 0;
        for (const [j, w] of neighbors) {
          // A node's self-loop (only present on aggregated super-nodes) is
          // internal to the node and travels with it, so it is not a link to
          // "other" members of its community — exclude it from the gain math.
          if (j === i) continue;
          const cj = currentComm[j];
          commWeights.set(cj, (commWeights.get(cj) ?? 0) + w);
          if (cj === ci) selfComm += w;
        }

        // Cost of removing i from its own community: the community's total
        // degree must exclude i itself (Σtot of ci \ {i}).
        const sigmaTotCI = commDegrees[ci] - ki;
        const removeCost = selfComm - (resolution * sigmaTotCI * ki) / currentM2;

        let bestComm = ci;
        let bestGain = 0;

        for (const [cj, wj] of commWeights) {
          if (cj === ci) continue;
          const sigmaTotCJ = commDegrees[cj];
          const gain = wj - (resolution * sigmaTotCJ * ki) / currentM2 - removeCost;
          if (gain > bestGain) {
            bestGain = gain;
            bestComm = cj;
          }
        }

        if (bestComm !== ci) {
          commDegrees[ci] -= ki;
          commDegrees[bestComm] += ki;
          currentComm[i] = bestComm;
          improved = true;
        }
      }
    }

    const commMap = new Map<number, number>();
    let nextId = 0;
    const normalized = new Array(currentNodes);
    for (let i = 0; i < currentNodes; i++) {
      const c = currentComm[i];
      if (!commMap.has(c)) commMap.set(c, nextId++);
      normalized[i] = commMap.get(c)!;
    }
    const numComms = nextId;

    // Record the normalized level-0 community id of the disconnected group so
    // the UI can find and label the single "Miscellaneous" cluster. It keeps
    // this id composed up through the hierarchy (it never merges).
    if (level === 0 && miscSeed >= 0) miscCommunity = normalized[miscSeed];

    // A pass that leaves every node in its own community produces no merge —
    // the resulting level would be an identity map (and would render
    // identically to the level below it). Drop it: stop without pushing for
    // any level above the base. Level 0 is always kept since it is the base
    // node→community assignment that the rest of the hierarchy composes from.
    if (numComms === currentNodes && level > 0) break;

    currentComm = normalized;
    levels.push([...currentComm]);

    if (numComms === currentNodes) break;

    const newAdj = new Map<number, Map<number, number>>();
    const newKDeg = new Float64Array(numComms);

    for (let i = 0; i < currentNodes; i++) {
      const ci = currentComm[i];
      newKDeg[ci] += currentKDeg[i];
      const neighbors = currentAdj.get(i);
      if (!neighbors) continue;
      for (const [j, w] of neighbors) {
        const cj = currentComm[j];
        if (!newAdj.has(ci)) newAdj.set(ci, new Map());
        newAdj.get(ci)!.set(cj, (newAdj.get(ci)!.get(cj) ?? 0) + w);
      }
    }

    currentAdj = newAdj;
    currentNodes = numComms;
    currentKDeg = newKDeg;
    currentComm = Array.from({ length: numComms }, (_, i) => i);
  }

  const finalComm = new Array(nodeCount).fill(0);
  if (levels.length > 0) {
    for (let i = 0; i < nodeCount; i++) {
      let c = i;
      for (const lvl of levels) {
        c = lvl[c];
      }
      finalComm[i] = c;
    }
  }

  const mod = _modularity(adj, finalComm, kDeg, m2, nodeCount, resolution);

  return { levels, communities: finalComm, modularity: mod, miscCommunity };
}


function _modularity(
  adj: Map<number, Map<number, number>>,
  comm: number[],
  kDeg: Float64Array,
  m2: number,
  n: number,
  resolution: number,
): number {
  let q = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = adj.get(i);
    if (!neighbors) continue;
    for (const [j, w] of neighbors) {
      if (comm[i] === comm[j]) {
        q += w - (resolution * kDeg[i] * kDeg[j]) / m2;
      }
    }
  }
  return q / m2;
}

export function getCommunitiesAtLevel(
  levels: number[][],
  nodeCount: number,
  targetLevel: number,
): number[] {
  const lvl = Math.min(targetLevel, levels.length - 1);
  const comm = new Array(nodeCount).fill(0);
  for (let i = 0; i < nodeCount; i++) {
    let c = i;
    for (let l = 0; l <= lvl; l++) {
      c = levels[l][c];
    }
    comm[i] = c;
  }
  return comm;
}
