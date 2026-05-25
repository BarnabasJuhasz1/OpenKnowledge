from __future__ import annotations
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_PAGE_SIZE = 100  # Europe PMC max pageSize


class EuropePmcAdapter(DatabaseAdapter):
    name = "europe_pmc"
    rate_limit = 10
    _BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"

    async def search(self, query: str) -> list[Paper]:
        all_papers: list[Paper] = []
        cursor_mark = "*"

        while True:
            params = {
                "query": query,
                "format": "json",
                "pageSize": _PAGE_SIZE,
                "cursorMark": cursor_mark,
                "resultType": "core",
            }

            async with self._semaphore:
                resp = await self._get_client().get(self._BASE, params=params)
                resp.raise_for_status()

            data = resp.json()
            results = (data.get("resultList") or {}).get("result") or []
            batch = [self._normalize(r) for r in results]
            all_papers.extend(batch)

            next_cursor = data.get("nextCursorMark")
            if len(results) == 0 or not next_cursor or next_cursor == cursor_mark:
                break
            cursor_mark = next_cursor

        return all_papers

    def _normalize(self, r: dict) -> Paper:
        author_string = r.get("authorString") or ""
        authors = [
            Author(name=name.strip())
            for name in author_string.rstrip(".").split(",")
            if name.strip()
        ]

        mesh_raw = r.get("meshHeadingList") or {}
        mesh_terms = [
            m.get("meshHeading", "")
            for m in (mesh_raw.get("meshHeading") or [])
            if m.get("meshHeading")
        ]

        kw_raw = r.get("keywordList") or {}
        keywords = kw_raw.get("keyword") or []

        full_text_urls = (r.get("fullTextUrlList") or {}).get("fullTextUrl") or []
        pdf_url = next(
            (u.get("url") for u in full_text_urls if u.get("documentStyle") == "pdf"),
            None,
        )

        pub_year = r.get("pubYear")
        year = int(pub_year) if pub_year and str(pub_year).isdigit() else None

        return Paper(
            doi=r.get("doi"),
            pubmed_id=r.get("pmid"),
            arxiv_id=None,
            title=r.get("title") or "",
            abstract=r.get("abstractText"),
            year=year,
            publication_date=r.get("firstPublicationDate"),
            authors=authors,
            journal=r.get("journalTitle"),
            venue=r.get("journalTitle"),
            is_open_access=r.get("isOpenAccess") == "Y",
            pdf_url=pdf_url,
            citation_count=r.get("citedByCount"),
            mesh_terms=mesh_terms,
            keywords=keywords,
            is_peer_reviewed=r.get("pubType", "").lower() == "journal article",
            sources=["europe_pmc"],
        )
