from __future__ import annotations
from ...models.paper import Paper, Author

# Priority order per field: first source in the list wins if it has a value
_TITLE_PRIORITY = ["crossref", "openalex", "semantic_scholar", "europe_pmc", "dblp", "pubmed", "arxiv", "core"]
_ABSTRACT_PRIORITY = ["semantic_scholar", "openalex", "europe_pmc", "arxiv", "pubmed", "core"]
_AUTHORS_PRIORITY = ["openalex", "crossref", "europe_pmc", "semantic_scholar", "pubmed", "dblp", "arxiv", "core"]
_VENUE_PRIORITY = ["crossref", "openalex", "dblp", "semantic_scholar", "europe_pmc", "pubmed"]
_CITATION_PRIORITY = ["semantic_scholar", "openalex", "crossref", "europe_pmc"]
_REFS_PRIORITY = ["semantic_scholar", "openalex"]
_PDF_PRIORITY = ["core", "arxiv", "europe_pmc", "openalex", "semantic_scholar"]
_OA_PRIORITY = ["openalex", "europe_pmc", "semantic_scholar", "crossref", "arxiv", "core"]


def _by_source(group: list[Paper], priority: list[str]) -> list[Paper]:
    """Return papers in group sorted by priority list."""
    order = {src: i for i, src in enumerate(priority)}
    def key(p: Paper) -> int:
        for src in p.sources:
            if src in order:
                return order[src]
        return len(priority)
    return sorted(group, key=key)


def _first(group: list[Paper], priority: list[str], attr: str):
    for p in _by_source(group, priority):
        val = getattr(p, attr, None)
        if val:
            return val
    return None


def merge_group(group: list[Paper]) -> Paper:
    """Merge a group of duplicate Paper objects into a single authoritative record."""
    if len(group) == 1:
        return group[0]

    # Collect all sources
    all_sources = list({src for p in group for src in p.sources})

    # Gather all IDs (take any non-None value)
    def _any(attr: str):
        return next((getattr(p, attr) for p in group if getattr(p, attr)), None)

    # Fields of study / keywords / mesh — union across all sources
    all_fields = list({f for p in group for f in p.fields_of_study if f})
    all_keywords = list({k for p in group for k in p.keywords if k})
    all_mesh = list({m for p in group for m in p.mesh_terms if m})
    all_refs = list({r for p in group for r in p.references if r})
    all_ref_by = list({r for p in group for r in p.referenced_by if r})

    # Versions — only arXiv provides these
    versions = next((p.versions for p in group if p.versions), None)

    # is_peer_reviewed: True wins over None, True wins over False
    peer_reviewed: bool | None = None
    for p in group:
        if p.is_peer_reviewed is True:
            peer_reviewed = True
            break
        if p.is_peer_reviewed is False:
            peer_reviewed = False

    return Paper(
        # Identifiers — take any available
        doi=_any("doi"),
        arxiv_id=_any("arxiv_id"),
        semantic_scholar_id=_any("semantic_scholar_id"),
        openalex_id=_any("openalex_id"),
        pubmed_id=_any("pubmed_id"),
        dblp_key=_any("dblp_key"),
        core_id=_any("core_id"),

        # Core fields
        title=_first(group, _TITLE_PRIORITY, "title") or group[0].title,
        abstract=_first(group, _ABSTRACT_PRIORITY, "abstract"),
        year=_any("year"),
        publication_date=_any("publication_date"),

        # Authors — from highest-priority source that has them
        authors=_first(group, _AUTHORS_PRIORITY, "authors") or [],

        # Venue
        journal=_first(group, _VENUE_PRIORITY, "journal"),
        venue=_first(group, _VENUE_PRIORITY, "venue"),
        volume=_first(group, _VENUE_PRIORITY, "volume"),
        issue=_first(group, _VENUE_PRIORITY, "issue"),
        pages=_first(group, _VENUE_PRIORITY, "pages"),
        publisher=_any("publisher"),
        issn=_any("issn"),
        isbn=_any("isbn"),

        # Classification — union
        fields_of_study=all_fields,
        keywords=all_keywords,
        mesh_terms=all_mesh,

        # Access
        is_open_access=any(p.is_open_access for p in group),
        pdf_url=_first(group, _PDF_PRIORITY, "pdf_url"),
        landing_url=_any("landing_url"),

        # Citations
        citation_count=_first(group, _CITATION_PRIORITY, "citation_count"),
        reference_count=_any("reference_count"),
        references=all_refs,
        referenced_by=all_ref_by,

        # Quality
        is_peer_reviewed=peer_reviewed,
        has_public_code=_any("has_public_code"),
        code_url=_any("code_url"),

        # Versioning
        versions=versions,

        # BibTeX — populated later by bibtex module
        bibtex=_any("bibtex"),

        sources=all_sources,
    )
