from __future__ import annotations
import re
from rapidfuzz import fuzz
from ...models.paper import Paper

_DOI_PREFIX = re.compile(r"^https?://(?:dx\.)?doi\.org/", re.I)
_ARXIV_VERSION = re.compile(r"v\d+$")
_NON_ALPHA = re.compile(r"[^a-z0-9 ]")


def _norm_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    return _DOI_PREFIX.sub("", doi).lower().strip()


def _norm_arxiv(arxiv_id: str | None) -> str | None:
    if not arxiv_id:
        return None
    return _ARXIV_VERSION.sub("", arxiv_id).strip()


def _norm_title(title: str) -> str:
    return _NON_ALPHA.sub("", title.lower()).strip()


def deduplicate(papers: list[Paper]) -> tuple[list[Paper], int]:
    """
    Merge duplicate papers. Returns (deduplicated_list, n_removed).
    Duplicate detection order:
      1. DOI match
      2. arXiv ID match
      3. Semantic Scholar / OpenAlex / PubMed ID match
      4. Fuzzy title + same year (threshold 92)
    """
    groups: list[list[Paper]] = []

    # Index structures for O(1) lookups
    doi_index: dict[str, int] = {}          # norm_doi → group index
    arxiv_index: dict[str, int] = {}        # norm_arxiv_id → group index
    ss_index: dict[str, int] = {}           # semantic_scholar_id → group index
    oa_index: dict[str, int] = {}           # openalex_id → group index
    pm_index: dict[str, int] = {}           # pubmed_id → group index
    title_year_index: dict[tuple, int] = {} # (norm_title, year) → group index

    def _find_group(paper: Paper) -> int | None:
        doi = _norm_doi(paper.doi)
        if doi and doi in doi_index:
            return doi_index[doi]

        arxiv = _norm_arxiv(paper.arxiv_id)
        if arxiv and arxiv in arxiv_index:
            return arxiv_index[arxiv]

        if paper.semantic_scholar_id and paper.semantic_scholar_id in ss_index:
            return ss_index[paper.semantic_scholar_id]
        if paper.openalex_id and paper.openalex_id in oa_index:
            return oa_index[paper.openalex_id]
        if paper.pubmed_id and paper.pubmed_id in pm_index:
            return pm_index[paper.pubmed_id]

        return None

    def _fuzzy_find(paper: Paper) -> int | None:
        nt = _norm_title(paper.title)
        if not nt:
            return None
        # Exact normalised title + year match first (fast path)
        key = (nt, paper.year)
        if key in title_year_index:
            return title_year_index[key]
        # Fuzzy fallback — only check same year to limit comparisons
        for (existing_title, existing_year), gidx in title_year_index.items():
            if existing_year != paper.year:
                continue
            if fuzz.token_sort_ratio(nt, existing_title) >= 92:
                return gidx
        return None

    def _register(paper: Paper, gidx: int) -> None:
        doi = _norm_doi(paper.doi)
        if doi:
            doi_index[doi] = gidx
        arxiv = _norm_arxiv(paper.arxiv_id)
        if arxiv:
            arxiv_index[arxiv] = gidx
        if paper.semantic_scholar_id:
            ss_index[paper.semantic_scholar_id] = gidx
        if paper.openalex_id:
            oa_index[paper.openalex_id] = gidx
        if paper.pubmed_id:
            pm_index[paper.pubmed_id] = gidx
        nt = _norm_title(paper.title)
        if nt:
            title_year_index[(nt, paper.year)] = gidx

    for paper in papers:
        gidx = _find_group(paper)
        if gidx is None:
            gidx = _fuzzy_find(paper)
        if gidx is not None:
            groups[gidx].append(paper)
            _register(paper, gidx)
        else:
            gidx = len(groups)
            groups.append([paper])
            _register(paper, gidx)

    n_removed = len(papers) - len(groups)
    return groups, n_removed
