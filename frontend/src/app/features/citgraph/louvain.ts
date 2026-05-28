export interface LouvainResult {
  levels: number[][];
  communities: number[];
  modularity: number;
}

export function louvain(
  nodeCount: number,
  edges: { source: number; target: number; weight?: number }[],
): LouvainResult {
  if (nodeCount === 0) {
    return { levels: [], communities: [], modularity: 0 };
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

  if (totalWeight === 0) {
    const comm = Array.from({ length: nodeCount }, (_, i) => i);
    return { levels: [comm], communities: comm, modularity: 0 };
  }

  const m2 = totalWeight * 2;
  let community = Array.from({ length: nodeCount }, (_, i) => i);
  const levels: number[][] = [];

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

  for (let level = 0; level < 10; level++) {
    let improved = true;
    let iterations = 0;

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
          const cj = currentComm[j];
          commWeights.set(cj, (commWeights.get(cj) ?? 0) + w);
          if (cj === ci) selfComm += w;
        }

        const sigmaTotCI = _sigmaTot(currentComm, currentKDeg, ci, currentNodes);
        const removeCost = selfComm - (sigmaTotCI * ki) / currentM2;

        let bestComm = ci;
        let bestGain = 0;

        for (const [cj, wj] of commWeights) {
          if (cj === ci) continue;
          const sigmaTotCJ = _sigmaTot(currentComm, currentKDeg, cj, currentNodes);
          const gain = wj - (sigmaTotCJ * ki) / currentM2 - removeCost;
          if (gain > bestGain) {
            bestGain = gain;
            bestComm = cj;
          }
        }

        if (bestComm !== ci) {
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
    currentComm = normalized;
    levels.push([...currentComm]);

    const numComms = nextId;
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

  const mod = _modularity(adj, finalComm, kDeg, m2, nodeCount);

  return { levels, communities: finalComm, modularity: mod };
}

function _sigmaTot(comm: number[], kDeg: Float64Array, c: number, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (comm[i] === c) sum += kDeg[i];
  }
  return sum;
}

function _modularity(
  adj: Map<number, Map<number, number>>,
  comm: number[],
  kDeg: Float64Array,
  m2: number,
  n: number,
): number {
  let q = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = adj.get(i);
    if (!neighbors) continue;
    for (const [j, w] of neighbors) {
      if (comm[i] === comm[j]) {
        q += w - (kDeg[i] * kDeg[j]) / m2;
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
