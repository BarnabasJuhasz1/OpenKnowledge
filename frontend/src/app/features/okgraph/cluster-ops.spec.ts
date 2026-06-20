import { describe, it, expect } from 'vitest';
import { placedIdsInCluster, subclusterCount, ClusterMember } from './cluster-ops';

/**
 * 6 base nodes across two clusters at the current view level.
 *   index:        0     1     2     3     4     5
 *   community:    10    10    11    10    11    12
 */
const communityAtLevel = [10, 10, 11, 10, 11, 12];

const placed: ClusterMember[] = [
  { id: 'a', repIndex: 0 },
  { id: 'b', repIndex: 1 },
  { id: 'c', repIndex: 2 },
  { id: 'd', repIndex: 3 },
  { id: 'e', repIndex: 4 },
];

describe('placedIdsInCluster', () => {
  it('returns every placed node whose community matches the target', () => {
    expect(placedIdsInCluster(placed, communityAtLevel, 10)).toEqual(['a', 'b', 'd']);
    expect(placedIdsInCluster(placed, communityAtLevel, 11)).toEqual(['c', 'e']);
  });

  it('returns an empty list when no placed node belongs to the cluster', () => {
    // Community 12 (index 5) exists in the level map but has no placed node.
    expect(placedIdsInCluster(placed, communityAtLevel, 12)).toEqual([]);
    expect(placedIdsInCluster(placed, communityAtLevel, 99)).toEqual([]);
  });

  it('isolates a single (sub)cluster — unique ids per level mean no cross-talk', () => {
    // Removing cluster 11 never touches cluster 10's nodes.
    const removed = new Set(placedIdsInCluster(placed, communityAtLevel, 11));
    const survivors = placed.filter(p => !removed.has(p.id)).map(p => p.id);
    expect(survivors).toEqual(['a', 'b', 'd']);
  });

  it('handles an empty placed set', () => {
    expect(placedIdsInCluster([], communityAtLevel, 10)).toEqual([]);
  });
});

describe('subclusterCount', () => {
  /**
   * 6 nodes. At the current (parent) level there are two clusters, 10 and 11.
   * One level finer they split into child communities:
   *   index:   0    1    2    3    4    5
   *   parent:  10   10   10   11   11   11
   *   child:   1    1    2    3    3    3
   * So cluster 10 fans out into 2 sub-clusters (1, 2) and cluster 11 into 1 (3).
   */
  const parent = [10, 10, 10, 11, 11, 11];
  const child = [1, 1, 2, 3, 3, 3];

  it('counts distinct child communities within a cluster', () => {
    expect(subclusterCount(parent, child, 10)).toBe(2);
    expect(subclusterCount(parent, child, 11)).toBe(1);
  });

  it('returns 0 for a cluster with no members', () => {
    expect(subclusterCount(parent, child, 99)).toBe(0);
  });

  it('counts every member as its own sub-cluster at the leaf level', () => {
    // At the leaf level each node is its own child community (index identity).
    const leafChild = [0, 1, 2, 3, 4, 5];
    expect(subclusterCount(parent, leafChild, 10)).toBe(3);
  });
});
