import { describe, it, expect } from 'vitest';
import { seedsOnlyGuardMessage } from './graph-build-guard';

describe('seedsOnlyGuardMessage', () => {
  it('passes (null) when the graph has at least one expanded non-seed node', () => {
    const nodes = [{ hop: 0 }, { hop: 0 }, { hop: 1 }];
    expect(seedsOnlyGuardMessage(nodes, true)).toBeNull();
    expect(seedsOnlyGuardMessage(nodes, false)).toBeNull();
  });

  it('blocks a seeds-only graph and points at the filter when filtering is active', () => {
    const seedsOnly = [{ hop: 0 }, { hop: 0 }];
    expect(seedsOnlyGuardMessage(seedsOnly, true)).toBe(
      'No papers matched your filtering criteria. Try loosening the filters.',
    );
  });

  it('blocks a seeds-only graph with a connectivity message when no filter is active', () => {
    const seedsOnly = [{ hop: 0 }];
    expect(seedsOnlyGuardMessage(seedsOnly, false)).toBe(
      'No connected papers were found for the selected seeds.',
    );
  });

  it('treats a missing hop as a seed (hop 0)', () => {
    expect(seedsOnlyGuardMessage([{}, {}], true)).not.toBeNull();
    expect(seedsOnlyGuardMessage([{}, { hop: 2 }], true)).toBeNull();
  });

  it('blocks an empty graph too', () => {
    expect(seedsOnlyGuardMessage([], false)).toBe(
      'No connected papers were found for the selected seeds.',
    );
  });
});
