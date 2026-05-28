from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel, Field


class Author(BaseModel):
    name: str
    openalex_id: str | None = None
    semantic_scholar_id: str | None = None
    orcid: str | None = None
    affiliations: list[str] = []


class PaperVersion(BaseModel):
    version: str
    submitted: str
    summary: str | None = None


class Paper(BaseModel):
    # Identifiers
    doi: str | None = None
    arxiv_id: str | None = None
    semantic_scholar_id: str | None = None
    openalex_id: str | None = None
    pubmed_id: str | None = None
    dblp_key: str | None = None
    core_id: str | None = None

    # Core metadata
    title: str
    abstract: str | None = None
    year: int | None = None
    publication_date: str | None = None

    # Authors
    authors: list[Author] = []

    # Venue
    journal: str | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    publisher: str | None = None
    issn: str | None = None
    isbn: str | None = None

    # Classification
    fields_of_study: list[str] = []
    keywords: list[str] = []
    mesh_terms: list[str] = []

    # Access
    is_open_access: bool = False
    pdf_url: str | None = None
    landing_url: str | None = None

    # Citations
    citation_count: int | None = None
    reference_count: int | None = None
    referenced_by: list[str] = []
    references: list[str] = []

    # Quality signals
    is_peer_reviewed: bool | None = None
    has_public_code: bool | None = None
    code_url: str | None = None
    has_dataset: bool = False
    repo_stars: int = 0

    # Versioning (arXiv only)
    versions: list[PaperVersion] | None = None

    # Computed / meta
    bibtex: str | None = None
    sources: list[str] = []
    retrieved_at: datetime = Field(default_factory=datetime.utcnow)


class StreamEvent(BaseModel):
    source: str
    papers: list[Paper]
    query_used: str
    failed: bool = False
    error_message: str | None = None


class SearchRequest(BaseModel):
    keywords: list[str]
    raw_query: str | None = None  # Original boolean query string; used as-is for all APIs
    databases: list[str] | None = None  # None = all
    domain_filter: str | None = None
    max_initial_results: int = 1000  # Per-adapter cap for initial fast response
    max_total_results: int | None = 10000  # Per-adapter cap for total results (None = no cap)
    continue_in_background: bool = True  # Keep paginating after initial results


class SearchResponse(BaseModel):
    papers: list[Paper]
    total_found: int
    total_available: int | None = None  # Estimated total across all APIs (if known)
    sources_queried: list[str]
    sources_failed: list[str]
    queries_used: dict[str, str] = {}
    deduplication_removed: int
    background_job_id: str | None = None  # Non-null if background fetch is continuing
    retrieved_at: datetime = Field(default_factory=datetime.utcnow)


class BackgroundProgress(BaseModel):
    """SSE event for background fetch progress."""
    job_id: str
    source: str
    papers_fetched: int  # Papers fetched so far from this source
    total_papers: int  # Total papers fetched across all sources
    estimated_remaining: int | None = None
    is_complete: bool = False
    error: str | None = None


class ScoreWeights(BaseModel):
    w_c: float = 1.0
    w_code: float = 1.0
    w_peer: float = 1.0
    w_data: float = 1.0
    w_stars: float = 1.0


class ScorePapersRequest(BaseModel):
    weights: ScoreWeights = Field(default_factory=ScoreWeights)
    limit: int = 50


class ScoredPaper(BaseModel):
    title: str
    authors: list[Author] = []
    year: int | None = None
    journal: str | None = None
    venue: str | None = None
    citation_count: int | None = None
    has_public_code: bool | None = None
    is_peer_reviewed: bool | None = None
    has_dataset: bool = False
    repo_stars: int = 0
    ok_score: float


class ScorePapersResponse(BaseModel):
    papers: list[ScoredPaper]
    total_scored: int


class ScoreBreakdown(BaseModel):
    citations_contribution: float
    code_contribution: float
    peer_review_contribution: float
    dataset_contribution: float
    stars_contribution: float


class PaperScoreResponse(BaseModel):
    title: str
    ok_score: float
    breakdown: ScoreBreakdown
