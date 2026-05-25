from __future__ import annotations
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_SELECT = ",".join([
    "DOI", "title", "author", "abstract", "published",
    "container-title", "volume", "issue", "page",
    "publisher", "ISSN", "ISBN", "type",
    "is-referenced-by-count", "reference-count",
    "link", "subject",
])

_PAGE_SIZE = 100  # CrossRef max rows per request


class CrossRefAdapter(DatabaseAdapter):
    name = "crossref"
    rate_limit = 10
    _BASE = "https://api.crossref.org/works"

    async def search(self, query: str) -> list[Paper]:
        all_papers: list[Paper] = []
        offset = 0

        while True:
            params: dict = {
                "query": query,
                "rows": _PAGE_SIZE,
                "offset": offset,
                "select": _SELECT,
            }
            if self._contact_email:
                params["mailto"] = self._contact_email

            async with self._semaphore:
                resp = await self._get_client().get(self._BASE, params=params)
                resp.raise_for_status()

            data = resp.json().get("message") or {}
            total: int = data.get("total-results", 0)
            items = data.get("items") or []
            batch = [self._normalize(item) for item in items]
            all_papers.extend(batch)

            offset += len(batch)
            if offset >= total or len(batch) == 0:
                break

        return all_papers

    def _normalize(self, item: dict) -> Paper:
        authors = []
        for a in (item.get("author") or []):
            given = a.get("given", "")
            family = a.get("family", "")
            name = f"{given} {family}".strip() if given or family else a.get("name", "")
            if name:
                authors.append(Author(
                    name=name,
                    orcid=(a.get("ORCID") or "").replace("http://orcid.org/", "") or None,
                    affiliations=[
                        aff.get("name", "")
                        for aff in (a.get("affiliation") or [])
                        if aff.get("name")
                    ],
                ))

        published = item.get("published") or item.get("published-print") or {}
        date_parts = (published.get("date-parts") or [[]])[0]
        year = date_parts[0] if date_parts else None

        container = item.get("container-title") or []
        journal = container[0] if container else None

        issn_raw = item.get("ISSN") or []
        issn = issn_raw[0] if issn_raw else None

        isbn_raw = item.get("ISBN") or []
        isbn = isbn_raw[0] if isbn_raw else None

        pub_type = item.get("type") or ""
        is_peer_reviewed = pub_type in ("journal-article", "proceedings-article", "book-chapter")

        links = item.get("link") or []
        pdf_url = next(
            (lk.get("URL") for lk in links if lk.get("content-type") == "application/pdf"),
            None,
        )

        doi = (item.get("DOI") or "").strip() or None

        title_list = item.get("title") or []
        title = title_list[0] if title_list else ""

        return Paper(
            doi=doi,
            title=title,
            abstract=item.get("abstract"),
            year=year,
            authors=authors,
            journal=journal,
            venue=journal,
            volume=item.get("volume"),
            issue=item.get("issue"),
            pages=item.get("page"),
            publisher=item.get("publisher"),
            issn=issn,
            isbn=isbn,
            citation_count=item.get("is-referenced-by-count"),
            reference_count=item.get("reference-count"),
            is_peer_reviewed=is_peer_reviewed,
            pdf_url=pdf_url,
            keywords=item.get("subject") or [],
            sources=["crossref"],
        )
