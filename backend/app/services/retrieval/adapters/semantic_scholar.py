from __future__ import annotations
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_FIELDS = ",".join([
    "paperId", "externalIds", "url", "title", "abstract",
    "year", "referenceCount", "citationCount", "isOpenAccess",
    "openAccessPdf", "fieldsOfStudy", "s2FieldsOfStudy",
    "publicationTypes", "publicationDate", "journal",
    "authors",
])

_PAGE_SIZE = 100  # Semantic Scholar max per request


class SemanticScholarAdapter(DatabaseAdapter):
    name = "semantic_scholar"
    rate_limit = 1
    _BASE = "https://api.semanticscholar.org/graph/v1/paper/search"

    async def search(self, query: str) -> list[Paper]:
        all_papers: list[Paper] = []
        offset = 0

        while True:
            headers = {}
            if self._api_key:
                headers["x-api-key"] = self._api_key

            params = {
                "query": query,
                "fields": _FIELDS,
                "limit": _PAGE_SIZE,
                "offset": offset,
            }

            async with self._semaphore:
                resp = await self._get_client().get(self._BASE, params=params, headers=headers)
                resp.raise_for_status()

            data = resp.json()
            total: int = data.get("total", 0)
            batch = [self._normalize(p) for p in data.get("data", [])]
            all_papers.extend(batch)

            offset += len(batch)
            if offset >= total or len(batch) == 0:
                break

        return all_papers

    def _normalize(self, p: dict) -> Paper:
        ext = p.get("externalIds") or {}
        authors = [
            Author(name=a.get("name", ""), semantic_scholar_id=a.get("authorId"))
            for a in (p.get("authors") or [])
        ]
        journal = p.get("journal") or {}
        oa_pdf = p.get("openAccessPdf") or {}
        pub_types = p.get("publicationTypes") or []

        doi = ext.get("DOI")
        arxiv_id = ext.get("ArXiv")

        pages = journal.get("pages")
        volume = journal.get("volume")

        return Paper(
            doi=doi,
            arxiv_id=arxiv_id,
            semantic_scholar_id=p.get("paperId"),
            pubmed_id=ext.get("PubMed"),
            title=p.get("title") or "",
            abstract=p.get("abstract"),
            year=p.get("year"),
            publication_date=p.get("publicationDate"),
            authors=authors,
            journal=journal.get("name"),
            venue=journal.get("name"),
            volume=volume,
            pages=pages,
            is_open_access=p.get("isOpenAccess", False),
            pdf_url=oa_pdf.get("url"),
            citation_count=p.get("citationCount"),
            reference_count=p.get("referenceCount"),
            fields_of_study=p.get("fieldsOfStudy") or [],
            is_peer_reviewed=any(t in pub_types for t in ("JournalArticle", "Conference")),
            sources=["semantic_scholar"],
        )
