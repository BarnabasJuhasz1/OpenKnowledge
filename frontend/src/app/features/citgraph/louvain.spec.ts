import { describe, it, expect } from 'vitest';
import { louvain, getCommunitiesAtLevel } from './louvain';

describe('louvain', () => {
  it('handles empty graph', () => {
    const res = louvain(0, []);
    expect(res.communities).toEqual([]);
    expect(res.levels).toEqual([]);
  });

  it('assigns isolated nodes to their own communities', () => {
    const res = louvain(3, []);
    expect(res.communities.length).toBe(3);
  });

  it('detects two communities for two cliques joined by one edge', () => {
    // Clique A: 0,1,2 fully connected; Clique B: 3,4,5 fully connected; bridge 2-3
    const edges = [
      { source: 0, target: 1 },
      { source: 0, target: 2 },
      { source: 1, target: 2 },
      { source: 3, target: 4 },
      { source: 3, target: 5 },
      { source: 4, target: 5 },
      { source: 2, target: 3 },
    ];
    const res = louvain(6, edges);
    const distinct = new Set(res.communities).size;
    expect(distinct).toBe(2);
    // Members of clique A share a community
    expect(res.communities[0]).toBe(res.communities[1]);
    expect(res.communities[1]).toBe(res.communities[2]);
    // Members of clique B share a community
    expect(res.communities[3]).toBe(res.communities[4]);
    expect(res.communities[4]).toBe(res.communities[5]);
    // The two cliques are in different communities
    expect(res.communities[0]).not.toBe(res.communities[3]);
    // Positive modularity for well-separated clusters
    expect(res.modularity).toBeGreaterThan(0.2);
  });

  it('produces at least one hierarchy level and consistent level lookup', () => {
    const edges = [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
      { source: 2, target: 0 },
      { source: 3, target: 4 },
      { source: 4, target: 5 },
      { source: 5, target: 3 },
      { source: 2, target: 3 },
    ];
    const res = louvain(6, edges);
    expect(res.levels.length).toBeGreaterThanOrEqual(1);
    const lvl0 = getCommunitiesAtLevel(res.levels, 6, 0);
    expect(lvl0.length).toBe(6);
  });

  const distinctCount = (assignment: number[]) => new Set(assignment).size;

  // A chain of small triangles (clusters of clusters) — the kind of structure
  // that produces a genuine multi-level Louvain hierarchy: fine communities at
  // level 0 that further merge at level 1.
  const triangleChain = (() => {
    const nCliques = 8;
    const e: { source: number; target: number }[] = [];
    const clusters: number[][] = [];
    let id = 0;
    for (let c = 0; c < nCliques; c++) {
      const arr = [id++, id++, id++];
      clusters.push(arr);
      e.push(
        { source: arr[0], target: arr[1] },
        { source: arr[0], target: arr[2] },
        { source: arr[1], target: arr[2] },
      );
    }
    for (let p = 0; p < nCliques; p += 2)
      e.push({ source: clusters[p][0], target: clusters[p + 1][0] });
    for (let p = 1; p + 1 < nCliques; p += 2)
      e.push({ source: clusters[p][1], target: clusters[p + 1][1] });
    return { edges: e, n: id };
  })();

  it('builds a genuine multi-level hierarchy (level 1 is coarser than level 0)', () => {
    const { edges, n } = triangleChain;
    const res = louvain(n, edges);
    expect(res.levels.length).toBeGreaterThanOrEqual(2);
    const lvl0 = getCommunitiesAtLevel(res.levels, n, 0);
    const lvl1 = getCommunitiesAtLevel(res.levels, n, 1);
    expect(distinctCount(lvl1)).toBeLessThan(distinctCount(lvl0));
  });

  it('does not append a degenerate identity level', () => {
    const { edges, n } = triangleChain;
    const res = louvain(n, edges);
    // The coarsest level must actually merge communities relative to the one
    // below it (otherwise it would be an identity map rendering like level 0).
    expect(res.levels.length).toBeGreaterThanOrEqual(2);
    const last = getCommunitiesAtLevel(res.levels, n, res.levels.length - 1);
    const prev = getCommunitiesAtLevel(res.levels, n, res.levels.length - 2);
    expect(distinctCount(last)).toBeLessThan(distinctCount(prev));
  });

  it('respects the maxLevels cap', () => {
    const { edges, n } = triangleChain;
    expect(louvain(n, edges).levels.length).toBeGreaterThanOrEqual(2);
    expect(louvain(n, edges, { maxLevels: 1 }).levels.length).toBe(1);
  });

  it('threads the resolution parameter through modularity (higher γ → lower Q)', () => {
    // Two triangles joined by a single bridge. Raising the resolution grows the
    // null-model penalty, so the modularity of the detected partition falls.
    const edges = [
      { source: 0, target: 1 },
      { source: 0, target: 2 },
      { source: 1, target: 2 },
      { source: 3, target: 4 },
      { source: 3, target: 5 },
      { source: 4, target: 5 },
      { source: 2, target: 3 },
    ];
    const qLow = louvain(6, edges, { resolution: 0.5 }).modularity;
    const qMid = louvain(6, edges, { resolution: 1.0 }).modularity;
    const qHigh = louvain(6, edges, { resolution: 2.0 }).modularity;
    expect(qLow).toBeGreaterThan(qMid);
    expect(qMid).toBeGreaterThan(qHigh);
  });
});
