import { Paper } from '../../core/models/paper.model';
import { CitGraphNode } from '../../core/services/citgraph.service';

/** Citation-based representative score (matches the Cit-Graph "Send Reps" rule). */
export function repScore(n: CitGraphNode): number {
  return +(1.0 * Math.log10(1 + (n.citation_count || 0))).toFixed(2);
}

/** Build a Paper view-model from a cit-graph node (the ok-graph only renders a subset). */
export function citNodeToPaper(n: CitGraphNode, okScore: number): Paper {
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
    ok_score: okScore,
    has_public_code: false,
    is_peer_reviewed: false,
    has_dataset: false,
    repo_stars: 0,
  } as unknown as Paper;
}
