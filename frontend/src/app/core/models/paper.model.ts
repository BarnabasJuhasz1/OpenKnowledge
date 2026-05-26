export interface Author {
  name: string;
  openalex_id: string | null;
  semantic_scholar_id: string | null;
  orcid: string | null;
  affiliations: string[];
}

export interface PaperVersion {
  version: string;
  submitted: string;
  summary: string | null;
}

export interface Paper {
  doi: string | null;
  arxiv_id: string | null;
  semantic_scholar_id: string | null;
  openalex_id: string | null;
  pubmed_id: string | null;
  dblp_key: string | null;
  core_id: string | null;
  title: string;
  abstract: string | null;
  year: number | null;
  publication_date: string | null;
  authors: Author[];
  journal: string | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  is_open_access: boolean;
  pdf_url: string | null;
  landing_url: string | null;
  citation_count: number | null;
  reference_count: number | null;
  is_peer_reviewed: boolean | null;
  has_public_code: boolean | null;
  code_url: string | null;
  fields_of_study: string[];
  keywords: string[];
  bibtex: string | null;
  sources: string[];
  versions: PaperVersion[] | null;
  relevancy_score?: number;
}

export interface StreamEvent {
  source: string;
  papers: Paper[];
  query_used: string;
  failed: boolean;
  error_message: string | null;
}

export interface SearchRequest {
  keywords: string[];
  raw_query?: string;
  databases?: string[];
  domain_filter?: string;
}

export interface SearchResponse {
  papers: Paper[];
  total_found: number;
  sources_queried: string[];
  sources_failed: string[];
  queries_used: Record<string, string>;
  deduplication_removed: number;
}

export interface ScoreWeights {
  w_c: number;
  w_code: number;
  w_peer: number;
  w_data: number;
  w_stars: number;
}

export interface ScoredPaper {
  title: string;
  authors: Author[];
  year: number | null;
  journal: string | null;
  venue: string | null;
  citation_count: number | null;
  has_public_code: boolean | null;
  is_peer_reviewed: boolean | null;
  has_dataset: boolean;
  repo_stars: number;
  relevancy_score: number;
}

export interface ScoreBreakdown {
  citations_contribution: number;
  code_contribution: number;
  peer_review_contribution: number;
  dataset_contribution: number;
  stars_contribution: number;
}

export interface PaperScoreResponse {
  title: string;
  total_score: number;
  breakdown: ScoreBreakdown;
}

export interface ScorePapersResponse {
  papers: ScoredPaper[];
  total_scored: number;
}
