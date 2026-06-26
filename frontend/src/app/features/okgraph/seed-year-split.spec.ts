import { describe, it, expect } from 'vitest';
import { computeSeedYearSplit, SeedSplitNode, SeedSplitEdge } from './seed-year-split';

// Helper builders for readability.
const seed = (id: string, year: number): SeedSplitNode => ({ id, year, isSeed: true });
const node = (id: string, year: number): SeedSplitNode => ({ id, year, isSeed: false });
const cite = (source: string, target: string): SeedSplitEdge => ({ source, target });

describe('computeSeedYearSplit', () => {
  it('places a same-year reference left of the seed', () => {
    // seed S (2015) cites P (2015) ⇒ P is a reference ("before").
    const { rolesByYear, roleOf } = computeSeedYearSplit(
      [seed('S', 2015), node('P', 2015)],
      [cite('S', 'P')],
    );
    expect(rolesByYear.get(2015)).toEqual(['refs', 'seed']);
    expect(roleOf.get('P')).toBe('refs');
    expect(roleOf.get('S')).toBe('seed');
  });

  it('places a same-year citer right of the seed', () => {
    // Q (2015) cites seed S (2015) ⇒ Q is a citer ("after").
    const { rolesByYear, roleOf } = computeSeedYearSplit(
      [seed('S', 2015), node('Q', 2015)],
      [cite('Q', 'S')],
    );
    expect(rolesByYear.get(2015)).toEqual(['seed', 'citers']);
    expect(roleOf.get('Q')).toBe('citers');
  });

  it('builds the full 3x column when the seed cites and is cited the same year', () => {
    const { rolesByYear, roleOf } = computeSeedYearSplit(
      [seed('S', 2015), node('P', 2015), node('Q', 2015)],
      [cite('S', 'P'), cite('Q', 'S')],
    );
    expect(rolesByYear.get(2015)).toEqual(['refs', 'seed', 'citers']);
    expect(roleOf.get('P')).toBe('refs');
    expect(roleOf.get('Q')).toBe('citers');
  });

  it('adds the neutral "other" column for an unrelated same-year paper', () => {
    const { rolesByYear, roleOf } = computeSeedYearSplit(
      [seed('S', 2015), node('P', 2015), node('Q', 2015), node('U', 2015)],
      [cite('S', 'P'), cite('Q', 'S')], // U has no link to S
    );
    expect(rolesByYear.get(2015)).toEqual(['other', 'refs', 'seed', 'citers']);
    expect(roleOf.get('U')).toBe('other');
  });

  it('routes a both-directions/conflicting paper to "other"', () => {
    // P is cited by seedA AND cites seedB, all in 2015 ⇒ conflict ⇒ other.
    const { roleOf } = computeSeedYearSplit(
      [seed('A', 2015), seed('B', 2015), node('P', 2015)],
      [cite('A', 'P'), cite('P', 'B')],
    );
    expect(roleOf.get('P')).toBe('other');
  });

  it('does NOT split a seed year that has no other same-year papers', () => {
    const { rolesByYear, roleOf } = computeSeedYearSplit(
      [seed('S', 2015), node('P', 2014)], // P is a different year
      [cite('S', 'P')],
    );
    expect(rolesByYear.has(2015)).toBe(false);
    expect(roleOf.size).toBe(0);
  });

  it('never splits a year with no seed', () => {
    const { rolesByYear } = computeSeedYearSplit(
      [node('P', 2015), node('Q', 2015)],
      [cite('P', 'Q')],
    );
    expect(rolesByYear.size).toBe(0);
  });

  it('only counts same-year citation links (cross-year edges are ignored)', () => {
    // S(2015) cites P(2014): different year ⇒ P not pulled into 2015's split, and
    // 2015 has no other same-year node ⇒ no split.
    const { rolesByYear } = computeSeedYearSplit(
      [seed('S', 2015), node('P', 2014), node('Z', 2015)],
      [cite('S', 'P')], // Z unrelated, same year ⇒ forces an 'other' split
    );
    expect(rolesByYear.get(2015)).toEqual(['other', 'seed']);
  });
});
