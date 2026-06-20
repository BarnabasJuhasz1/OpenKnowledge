import { describe, it, expect } from 'vitest';
import {
  nodeMatchText,
  matchesKeywords,
  matchesNodeKeywords,
  highlightSegments,
} from './keyword-match';

/** Re-joining every segment must reproduce the original text exactly. */
function roundtrip(text: string, keywords: string[]): string {
  return highlightSegments(text, keywords).map(s => s.text).join('');
}

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

describe('highlightSegments', () => {
  it('flags case-insensitive substring matches for bolding', () => {
    const segs = highlightSegments('Graph neural networks are great', ['neural']);
    expect(segs).toEqual([
      { text: 'Graph ', match: false },
      { text: 'neural', match: true },
      { text: ' networks are great', match: false },
    ]);
  });

  it('matches regardless of case but preserves original casing', () => {
    const segs = highlightSegments('ATTENTION is all you need', ['attention']);
    expect(segs[0]).toEqual({ text: 'ATTENTION', match: true });
  });

  it('highlights all occurrences of multiple keywords', () => {
    const segs = highlightSegments('rag and rag again with llm', ['rag', 'llm']);
    const bold = segs.filter(s => s.match).map(s => s.text);
    expect(bold).toEqual(['rag', 'rag', 'llm']);
  });

  it('merges overlapping matches into one run', () => {
    // "graph" and "graphs" overlap, so they collapse to a single bold run.
    expect(highlightSegments('graphs', ['graph', 'graphs'])).toEqual([
      { text: 'graphs', match: true },
    ]);
  });

  it('keeps non-overlapping matches separate (gap preserved)', () => {
    const segs = highlightSegments('retrieval-augmented', ['retrieval', 'augmented']);
    expect(segs).toEqual([
      { text: 'retrieval', match: true },
      { text: '-', match: false },
      { text: 'augmented', match: true },
    ]);
  });

  it('returns a single unmatched segment when nothing matches', () => {
    expect(highlightSegments('nothing here', ['xyz'])).toEqual([
      { text: 'nothing here', match: false },
    ]);
  });

  it('treats empty/short keyword lists as no highlight', () => {
    expect(highlightSegments('some text', [])).toEqual([{ text: 'some text', match: false }]);
    expect(highlightSegments('a i o', ['a', 'i'])).toEqual([{ text: 'a i o', match: false }]);
  });

  it('returns an empty array for empty text', () => {
    expect(highlightSegments('', ['x'])).toEqual([]);
  });

  it('never loses or reorders text (roundtrip)', () => {
    const text = 'Deep learning with graphs, graphs, and more GRAPHS.';
    expect(roundtrip(text, ['graph', 'deep', 'learning'])).toBe(text);
    expect(roundtrip(text, [])).toBe(text);
  });
});
