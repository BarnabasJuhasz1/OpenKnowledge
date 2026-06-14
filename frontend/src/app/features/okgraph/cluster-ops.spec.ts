import { describe, it, expect } from 'vitest';
import { placedIdsInCluster, ClusterMember } from './cluster-ops';

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
