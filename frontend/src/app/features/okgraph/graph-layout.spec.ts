import { describe, it, expect } from 'vitest';
import { citationLinksBetweenPlaced, PlacedRef } from './graph-layout';

/**
 * 6 base papers. Two-level hierarchy used by the tests:
 *
 *   base index:     0     1     2     3     4     5
 *   paper_id:      p0    p1    p2    p3    p4    p5
 *   level-0 comm:   0     1     2     2     3     3   (sub-clusters)
 *   level-1 comm:   0     0     1     1     1     1   (top clusters: A / B)
 *
 * Top view (level 1): {0,1} = top-cluster A, {2,3,4,5} = top-cluster B.
 * One level finer, B splits into sub-clusters {2,3}=comm2 and {4,5}=comm3.
 */
const idxOf = new Map<string, number>([
  ['p0', 0], ['p1', 1], ['p2', 2], ['p3', 3], ['p4', 4], ['p5', 5],
]);
const baseCount = 6;
const level0 = [0, 1, 2, 2, 3, 3];
const level1 = [0, 0, 1, 1, 1, 1];
const communitiesAtLevel = (level: number): number[] => {
  if (level <= -1) return [0, 1, 2, 3, 4, 5]; // leaves: each its own
  return level === 0 ? level0 : level1;
};

describe('citationLinksBetweenPlaced', () => {
  it('links papers of a fully-expanded cluster (the "expand whole cluster" bug)', () => {
    // Outer top view (level 1). "Expand whole cluster" placed all of B's papers
    // as leaves with NO manual links. Citation edges among them must still draw.
    const placed: PlacedRef[] = [
      { id: 'p2', repIndex: 2, level: -1, community: 2 },
      { id: 'p3', repIndex: 3, level: -1, community: 3 },
      { id: 'p4', repIndex: 4, level: -1, community: 4 },
      { id: 'p5', repIndex: 5, level: -1, community: 5 },
    ];
    const edges = citationLinksBetweenPlaced(
      placed,
      [{ source: 'p3', target: 'p4' }, { source: 'p2', target: 'p5' }],
      idxOf, level1, communitiesAtLevel, baseCount,
    );
    expect(edges).toEqual([
      { fromId: 'p3', toId: 'p4' },
      { fromId: 'p2', toId: 'p5' },
    ]);
  });

  it('links two leaves of the same sub-cluster in the drilled-in (inner) view', () => {
    // Entered cluster B → inner view is level 0. Two papers of sub-cluster comm2
    // share a lane; an edge between them links.
    const placed: PlacedRef[] = [
      { id: 'p2', repIndex: 2, level: -1, community: 2 },
      { id: 'p3', repIndex: 3, level: -1, community: 3 },
    ];
    const edges = citationLinksBetweenPlaced(
      placed, [{ source: 'p2', target: 'p3' }], idxOf, level0, communitiesAtLevel, baseCount,
    );
    expect(edges).toEqual([{ fromId: 'p2', toId: 'p3' }]);
  });

  it('drops cross-cluster citation edges (shown as bridges, not node links)', () => {
    // Top view: a paper of A and a paper of B are both placed; the edge between
    // them crosses top clusters, so no node link is drawn.
    const placed: PlacedRef[] = [
      { id: 'p1', repIndex: 1, level: -1, community: 1 },
      { id: 'p2', repIndex: 2, level: -1, community: 2 },
    ];
    const edges = citationLinksBetweenPlaced(
      placed, [{ source: 'p1', target: 'p2' }], idxOf, level1, communitiesAtLevel, baseCount,
    );
    expect(edges).toEqual([]);
  });

  it('ignores edges to papers that are not represented on the canvas', () => {
    const placed: PlacedRef[] = [
      { id: 'p3', repIndex: 3, level: -1, community: 3 },
    ]; // p4 not placed
    const edges = citationLinksBetweenPlaced(
      placed, [{ source: 'p3', target: 'p4' }], idxOf, level1, communitiesAtLevel, baseCount,
    );
    expect(edges).toEqual([]);
  });

  it('de-duplicates duplicate and reversed citation pairs', () => {
    const placed: PlacedRef[] = [
      { id: 'p2', repIndex: 2, level: -1, community: 2 },
      { id: 'p3', repIndex: 3, level: -1, community: 3 },
    ];
    const edges = citationLinksBetweenPlaced(
      placed,
      [
        { source: 'p2', target: 'p3' },
        { source: 'p3', target: 'p2' },
        { source: 'p2', target: 'p3' },
      ],
      idxOf, level1, communitiesAtLevel, baseCount,
    );
    expect(edges).toHaveLength(1);
  });

  it('maps each paper to the finest covering rep (mixed-granularity placement)', () => {
    // Top view of B with a coarse sub-cluster rep s45 (covers p4,p5) and the leaf
    // p2 both placed. Edge p2->p5 resolves p5 to s45 → one link p2–s45.
    const placed: PlacedRef[] = [
      { id: 'p2', repIndex: 2, level: -1, community: 2 },
      { id: 's45', repIndex: 4, level: 0, community: 3 },
    ];
    const edges = citationLinksBetweenPlaced(
      placed, [{ source: 'p2', target: 'p5' }], idxOf, level1, communitiesAtLevel, baseCount,
    );
    expect(edges).toEqual([{ fromId: 'p2', toId: 's45' }]);
  });
});
