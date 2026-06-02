import { describe, it, expect } from 'vitest';
import { yearExpandQueues, YearExpandOptions, middleYears } from './year-expand';

/**
 * Synthetic 6-node hierarchy, two top-level clusters.
 *
 *   index:        0     1     2     3     4     5
 *   year:       2020  2020  2021  2020  2020  2019
 *   score:        9     5     7     8     3     6
 *   level0 comm:  0     0     1     2     2     3
 *   level1 comm:  10    10    10    11    11    11   (top level = 1)
 *
 * Top cluster 10 = {0,1,2}, top cluster 11 = {3,4,5}.
 * Level-1 reps: comm10 -> idx0 (score 9), comm11 -> idx3 (score 8).
 * Level-0 reps: comm0 -> idx0, comm1 -> idx2, comm2 -> idx3, comm3 -> idx5.
 */
function baseOpts(over: Partial<YearExpandOptions> = {}): YearExpandOptions {
  return {
    commAtLevel: [
      [0, 0, 1, 2, 2, 3], // level 0
      [10, 10, 10, 11, 11, 11], // level 1 (top)
    ],
    currentTopLevel: 1,
    nodeYear: [2020, 2020, 2021, 2020, 2020, 2019],
    nodeScore: [9, 5, 7, 8, 3, 6],
    laneClusterOf: [10, 10, 10, 11, 11, 11],
    inView: [true, true, true, true, true, true],
    selectedYear: 2020,
    isPlaced: () => false,
    ...over,
  };
}

describe('yearExpandQueues', () => {
  it('orders by level descending then score descending', () => {
    // Year 2020 in cluster 10: idx0 (level1 rep, score9), idx1 (leaf, score5).
    const q = yearExpandQueues(baseOpts()).get(10)!;
    expect(q.map(c => c.paperIndex)).toEqual([0, 1]);
    expect(q[0].level).toBe(1);   // idx0 represents the top-level cluster
    expect(q[1].level).toBe(-1);  // idx1 represents nothing → leaf
  });

  it('represents a paper at the coarsest level it is a rep of', () => {
    // idx3 is the level-1 rep of cluster 11 AND a level-0 rep; surfaces at level 1.
    const q = yearExpandQueues(baseOpts()).get(11)!;
    expect(q[0].paperIndex).toBe(3);
    expect(q[0].level).toBe(1);
    expect(q[0].community).toBe(11);
  });

  it('breaks a same-level tie by higher score', () => {
    // Two leaves in the same cluster, same year: higher score comes first.
    const q = yearExpandQueues(baseOpts({
      commAtLevel: [[0, 0, 0], [5, 5, 5]],
      currentTopLevel: 1,
      nodeYear: [2020, 2020, 2020],
      nodeScore: [1, 9, 4], // idx1 is the rep (level1); idx0,idx2 are leaves
      laneClusterOf: [5, 5, 5],
      inView: [true, true, true],
      selectedYear: 2020,
    })).get(5)!;
    // idx1 (level1) first, then leaves by score desc: idx2 (4) before idx0 (1).
    expect(q.map(c => c.paperIndex)).toEqual([1, 2, 0]);
  });

  it('excludes other years and already-placed papers', () => {
    const placed = new Set([0]);
    const queues = yearExpandQueues(baseOpts({ isPlaced: i => placed.has(i) }));
    // idx0 placed → cluster 10 only has idx1 left; idx2 is 2021 (excluded).
    expect(queues.get(10)!.map(c => c.paperIndex)).toEqual([1]);
  });

  it('gives each lane cluster an independent queue', () => {
    const queues = yearExpandQueues(baseOpts());
    expect([...queues.keys()].sort()).toEqual([10, 11]);
    // Cluster 11, year 2020: idx3 (level1) then idx4 (leaf, score3). idx5 is 2019.
    expect(queues.get(11)!.map(c => c.paperIndex)).toEqual([3, 4]);
  });

  it('returns no queue entry when nothing matches the year', () => {
    const queues = yearExpandQueues(baseOpts({ selectedYear: 1990 }));
    expect(queues.size).toBe(0);
  });

  it('respects the inView mask (inner-view scoping)', () => {
    // Only cluster 11 in view.
    const queues = yearExpandQueues(baseOpts({
      inView: [false, false, false, true, true, true],
    }));
    expect([...queues.keys()]).toEqual([11]);
  });
});

describe('middleYears', () => {
  it('returns the single centre year of an odd-length range', () => {
    expect(middleYears(2010, 2014)).toEqual([2012]);
    expect(middleYears(2010, 2012)).toEqual([2011]);
  });

  it('returns both centre years of an even-length range', () => {
    expect(middleYears(2010, 2019)).toEqual([2014, 2015]);
    expect(middleYears(2010, 2013)).toEqual([2011, 2012]);
  });

  it('is order-independent in the two arguments', () => {
    expect(middleYears(2014, 2010)).toEqual([2012]);
    expect(middleYears(2019, 2010)).toEqual([2014, 2015]);
  });
});
