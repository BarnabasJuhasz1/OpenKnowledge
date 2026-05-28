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
});
