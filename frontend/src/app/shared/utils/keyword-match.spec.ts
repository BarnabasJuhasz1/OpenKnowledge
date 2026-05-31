import { describe, it, expect } from 'vitest';
import { nodeMatchText, matchesKeywords, matchesNodeKeywords } from './keyword-match';

describe('keyword-match', () => {
  it('matches when any keyword is a substring of title or abstract', () => {
    const text = nodeMatchText({ title: 'Deep Learning for Graphs', abstract: 'A study of GNNs.' });
    expect(matchesKeywords(text, ['graph'])).toBe(true);   // in title
    expect(matchesKeywords(text, ['gnn'])).toBe(true);     // in abstract
    expect(matchesKeywords(text, ['transformer'])).toBe(false);
  });

  it('is case-insensitive and OR semantics (any keyword)', () => {
    const text = nodeMatchText({ title: 'Attention Is All You Need', abstract: null });
    expect(matchesKeywords(text, ['ATTENTION'])).toBe(true);
    expect(matchesKeywords(text, ['rnn', 'attention'])).toBe(true); // one of many
    expect(matchesKeywords(text, ['rnn', 'lstm'])).toBe(false);
  });

  it('treats an empty keyword list as a no-op (matches everything)', () => {
    expect(matchesKeywords('anything', [])).toBe(true);
    expect(matchesNodeKeywords({ title: 'x', abstract: null }, [])).toBe(true);
  });

  it('handles missing abstract without throwing', () => {
    expect(matchesNodeKeywords({ title: 'Neural Nets', abstract: null }, ['neural'])).toBe(true);
    expect(matchesNodeKeywords({ title: 'Neural Nets', abstract: undefined as unknown as null }, ['bayes'])).toBe(false);
  });
});
