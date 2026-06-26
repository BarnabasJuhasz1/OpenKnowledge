import { describe, it, expect } from 'vitest';
import {
  parseBooleanQuery,
  matchesBooleanQuery,
  compileNodePredicate,
} from './boolean-query';

function match(query: string, title: string, abstract: string | null = null): boolean {
  return compileNodePredicate(query)({ title, abstract });
}

describe('parseBooleanQuery', () => {
  it('returns null for empty / whitespace / invalid queries', () => {
    expect(parseBooleanQuery('')).toBeNull();
    expect(parseBooleanQuery('   ')).toBeNull();
    expect(parseBooleanQuery('a AND')).toBeNull();
    expect(parseBooleanQuery('(a OR b')).toBeNull();
  });

  it('parses a single term', () => {
    expect(parseBooleanQuery('neural')).toEqual({ type: 'term', text: 'neural' });
  });
});

describe('matchesBooleanQuery / compileNodePredicate', () => {
  it('null AST (empty query) matches everything', () => {
    expect(matchesBooleanQuery('anything', null)).toBe(true);
    expect(match('', 'anything', 'at all')).toBe(true);
    expect(match('   ', 'x')).toBe(true);
  });

  it('single term substring, case-insensitive', () => {
    expect(match('neural', 'Neural Nets')).toBe(true);
    expect(match('NEURAL', 'neural networks')).toBe(true);
    expect(match('bayes', 'Neural Nets')).toBe(false);
  });

  it('matches abstract not just title', () => {
    expect(match('transformer', 'A study', 'uses a transformer model')).toBe(true);
    expect(match('transformer', 'A study', 'uses an RNN')).toBe(false);
  });

  it('phrase requires contiguous match', () => {
    expect(match('"large language model"', 'Large Language Model survey')).toBe(true);
    expect(match('"large language model"', 'language is large in this model')).toBe(false);
  });

  it('AND / OR / NOT / -term', () => {
    expect(match('a AND b', 'a b')).toBe(true);
    expect(match('a AND b', 'a')).toBe(false);
    expect(match('a OR b', 'only b here')).toBe(true);
    expect(match('a OR b', 'neither')).toBe(false);
    expect(match('NOT rag', 'retrieval methods')).toBe(true);
    expect(match('NOT rag', 'rag pipeline')).toBe(false);
    expect(match('-rag', 'rag pipeline')).toBe(false);
  });

  it('parentheses + precedence', () => {
    const pred = compileNodePredicate('(a OR b) AND c');
    expect(pred({ title: 'a c' })).toBe(true);
    expect(pred({ title: 'b c' })).toBe(true);
    expect(pred({ title: 'a b' })).toBe(false);
    expect(pred({ title: 'c only' })).toBe(false);
  });

  it('invalid query falls back to match-all', () => {
    expect(match('a AND', 'totally unrelated')).toBe(true);
    expect(match('(a OR b', 'unrelated')).toBe(true);
  });

  it('full search example (NOT > AND > OR)', () => {
    const raw = '"LLM" OR "Large Language Model" AND "compression" NOT "RAG"';
    const pred = compileNodePredicate(raw);
    expect(pred({ title: 'a paper about LLM systems' })).toBe(true);
    expect(pred({ title: 'Large Language Model compression study' })).toBe(true);
    expect(pred({ title: 'Large Language Model compression with RAG' })).toBe(false);
    expect(pred({ title: 'unrelated topic' })).toBe(false);
  });
});
