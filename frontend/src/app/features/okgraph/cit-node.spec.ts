import { describe, it, expect } from 'vitest';
import { okScore, repScore } from './cit-node';
import { CitGraphNode } from '../../core/services/citgraph.service';
import { ScoreWeights } from '../../core/models/paper.model';

const NEUTRAL: ScoreWeights = { w_c: 1, w_code: 1, w_peer: 1, w_data: 1, w_stars: 1 };

function node(partial: Partial<CitGraphNode>): CitGraphNode {
  return {
    paper_id: 'p',
    doi: null,
    arxiv_id: null,
    title: 't',
    abstract: null,
    year: 2020,
    citation_count: 0,
    reference_count: 0,
    authors: [],
    journal: null,
    is_open_access: false,
    pdf_url: null,
    fields_of_study: [],
    hop: 0,
    ...partial,
  };
}

describe('okScore', () => {
  it('reduces to the citation term (== repScore) when there is no enrichment', () => {
    const n = node({ citation_count: 99 });
    // log10(100) = 2
    expect(okScore(n, NEUTRAL)).toBe(2);
    expect(okScore(n, NEUTRAL)).toBe(repScore(n));
  });

  it('adds the binary enrichment terms with neutral weights', () => {
    const n = node({ citation_count: 0, has_public_code: true, is_peer_reviewed: true, has_dataset: true });
    // log10(1)=0 + 1 + 1 + 1 + log10(1)=0
    expect(okScore(n, NEUTRAL)).toBe(3);
  });

  it('includes the log-scaled repo stars term', () => {
    const n = node({ citation_count: 0, repo_stars: 9 });
    // log10(10) = 1
    expect(okScore(n, NEUTRAL)).toBe(1);
  });

  it('applies per-term weights', () => {
    const n = node({ citation_count: 9, has_public_code: true, repo_stars: 99 });
    const w: ScoreWeights = { w_c: 2, w_code: 3, w_peer: 1, w_data: 1, w_stars: 0.5 };
    // 2*log10(10)=2 + 3*1=3 + 0 + 0 + 0.5*log10(100)=1  => 6
    expect(okScore(n, w)).toBe(6);
  });

  it('treats missing/undefined enrichment as zero', () => {
    const n = node({ citation_count: 0 });
    expect(okScore(n, NEUTRAL)).toBe(0);
  });
});
