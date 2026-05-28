from __future__ import annotations
import asyncio
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
    _BASE = "https://api.semanticscholar.org/graph/v1/paper/search/bulk"

    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        all_papers: list[Paper] = []
        token: str | None = None
        is_first_request = True

        while True:
            headers = {}
            if self._api_key:
                headers["x-api-key"] = self._api_key

            params: dict[str, str | int] = {
                "query": query,
                "fields": _FIELDS,
            }
            if token is not None:
                params["token"] = token

            # Rate-limit: 1s delay between page requests (skip before first)
            if not is_first_request:
                await asyncio.sleep(1.0)
            is_first_request = False

            resp = await self._request_with_retry(
                "GET", self._BASE, params=params, headers=headers,
            )

            data = resp.json()
            batch = [self._normalize(p) for p in data.get("data", [])]
            all_papers.extend(batch)

            # Stop if max_results reached
            if max_results is not None and len(all_papers) >= max_results:
                all_papers = all_papers[:max_results]
                break

            token = data.get("token")
            if not token or len(batch) == 0:
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
