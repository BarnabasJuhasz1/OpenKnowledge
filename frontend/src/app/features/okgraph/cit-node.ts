import { Paper, ScoreWeights } from '../../core/models/paper.model';
import { CitGraphNode } from '../../core/services/citgraph.service';

/** Citation-only score (matches the Cit-Graph "Send Reps" rule). Used as the
 *  ok-score fallback when no project weights are available. */
export function repScore(n: CitGraphNode): number {
  return +(1.0 * Math.log10(1 + (n.citation_count || 0))).toFixed(2);
}

/**
 * Project ok-score for a cit-graph node — mirrors the backend scorer
 * (`backend/app/services/scorer.py`): a weighted sum of log-citations, public
 * code, peer review, dataset, and log-repo-stars. The enrichment flags are only
 * present when the node matched a paper in the active project's DB; otherwise
 * they default to 0/false and the score reduces to the citation term.
 */
export function okScore(n: CitGraphNode, w: ScoreWeights): number {
  const citations = n.citation_count || 0;
  const stars = n.repo_stars || 0;
  const code = n.has_public_code ? 1 : 0;
  const peer = n.is_peer_reviewed ? 1 : 0;
  const data = n.has_dataset ? 1 : 0;
  const score =
    w.w_c * Math.log10(1 + citations) +
    w.w_code * code +
    w.w_peer * peer +
    w.w_data * data +
    w.w_stars * Math.log10(1 + stars);
  return +score.toFixed(2);
}

/** Build a Paper view-model from a cit-graph node (the ok-graph only renders a subset). */
export function citNodeToPaper(n: CitGraphNode, score: number): Paper {
  return {
    title: n.title,
    authors: n.authors.map(a => ({ name: a, is_corresponding: false })),
    abstract: n.abstract,
    url: '',
    year: n.year,
    citation_count: n.citation_count,
    reference_count: n.reference_count,
    journal: n.journal,
    is_open_access: n.is_open_access,
    pdf_url: n.pdf_url,
    doi: n.doi,
    arxiv_id: n.arxiv_id,
    openalex_id: n.paper_id,
    semantic_scholar_id: n.paper_id,
    predicted_main_archetype: n.predicted_main_archetype ?? undefined,
    predicted_second_tier_archetype: n.predicted_second_tier_archetype ?? undefined,
    ok_score: score,
    has_public_code: n.has_public_code ?? false,
    is_peer_reviewed: n.is_peer_reviewed ?? false,
    has_dataset: n.has_dataset ?? false,
    repo_stars: n.repo_stars ?? 0,
  } as unknown as Paper;
}
