import { describe, it, expect } from 'vitest';
import {
  computeLevelCenters,
  levelCenterAtRank,
  packClusterBands,
  ClusterSide,
  LevelSpacingOpts,
} from './cluster-levels';

const OPTS: LevelSpacingOpts = { bandSpacing: 160, padTop: 40, padBottom: 50, minClear: 30 };

describe('computeLevelCenters', () => {
  it('returns empty for no ranks and [0] for a single rank', () => {
    expect(computeLevelCenters([], OPTS)).toEqual([]);
    expect(computeLevelCenters([0], OPTS)).toEqual([0]);
  });

  it('uses bandSpacing when stacks are short (extent-need below the floor)', () => {
    // needed = 0 + 50 + 30 + 40 + 0 = 120 < 160 → fixed bandSpacing wins.
    expect(computeLevelCenters([0, 0, 0], OPTS)).toEqual([0, 160, 320]);
  });

  it('expands the gap when a tall stack would otherwise overlap', () => {
    // Between rank 0 (half 64) and rank 1 (half 0):
    //   needed = 64 + 50 + 30 + 40 + 0 = 184 > 160 → gap 184.
    expect(computeLevelCenters([64, 0], OPTS)).toEqual([0, 184]);
  });

  it('never places adjacent padded blobs closer than minClear', () => {
    const half = [64, 64, 64];
    const centers = computeLevelCenters(half, OPTS);
    for (let i = 1; i < centers.length; i++) {
      const gap = centers[i] - centers[i - 1];
      const bottomOfPrev = half[i - 1] + OPTS.padBottom;
      const topOfCur = half[i] + OPTS.padTop;
      expect(gap - (bottomOfPrev + topOfCur)).toBeGreaterThanOrEqual(OPTS.minClear);
    }
  });
});

describe('levelCenterAtRank', () => {
  const centers = [0, 184, 344];
  it('returns 0 for an empty layout', () => {
    expect(levelCenterAtRank([], 1.5)).toBe(0);
  });
  it('clamps to the ends', () => {
    expect(levelCenterAtRank(centers, -1)).toBe(0);
    expect(levelCenterAtRank(centers, 5)).toBe(344);
  });
  it('returns exact centres on integer ranks', () => {
    expect(levelCenterAtRank(centers, 1)).toBe(184);
  });
  it('interpolates fractional ranks', () => {
    expect(levelCenterAtRank(centers, 0.5)).toBe(92);
    expect(levelCenterAtRank(centers, 1.5)).toBe(264);
  });
});

describe('packClusterBands', () => {
  const side = (m: Record<number, ClusterSide>) =>
    new Map<number, ClusterSide>(Object.entries(m).map(([k, v]) => [Number(k), v]));
  const half = (m: Record<number, number>) =>
    new Map<number, number>(Object.entries(m).map(([k, v]) => [Number(k), v]));

  it('centres the seed cluster at relative y = 0', () => {
    const y = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'right' }),
      half({}),
      new Set([1]),
      OPTS,
    );
    expect(y.get(1)).toBe(0);
  });

  it('lets a left and a right cluster share the same row beside the seed', () => {
    const y = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'right' }),
      half({}),
      new Set([1]),
      OPTS,
    );
    // First left and first right both fan to the same row (here, just below centre).
    expect(y.get(2)).toBe(y.get(3));
    expect(Math.abs(y.get(2)!)).toBe(OPTS.bandSpacing);
  });

  it('packs each side independently of the other side\'s height', () => {
    // A tall right cluster must NOT push the short left cluster further from centre.
    const tall = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'right' }),
      half({ 3: 400 }),         // right cluster very tall
      new Set([1]),
      OPTS,
    );
    const short = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'right' }),
      half({}),                 // both short
      new Set([1]),
      OPTS,
    );
    // Left cluster's distance from centre is the same regardless of the right height.
    expect(tall.get(2)).toBe(short.get(2));
    // The tall right cluster IS pushed out by its own extent, though.
    expect(Math.abs(tall.get(3)!)).toBeGreaterThan(Math.abs(short.get(3)!));
  });

  it('fans same-side clusters to opposite sides of the seed band', () => {
    const y = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'left' }),
      half({}),
      new Set([1]),
      OPTS,
    );
    // Two left clusters → one below, one above the centre (distinct rows).
    expect(y.get(2)).not.toBe(y.get(3));
    expect(Math.sign(y.get(2)!)).toBe(-Math.sign(y.get(3)!));
  });

  it('treats a non-seed spanning cluster as a central-column row', () => {
    const y = packClusterBands(
      [1, 2, 3],
      side({ 1: 'span', 2: 'left', 3: 'span' }),
      half({}),
      new Set([1]),
      OPTS,
    );
    // Spanning cluster 3 stacks in the centre column (not paired with left cluster 2).
    expect(y.get(3)).not.toBe(y.get(2));
    expect(y.get(3)).not.toBe(0);   // below/above the seed, but full-width centre column
  });
});
