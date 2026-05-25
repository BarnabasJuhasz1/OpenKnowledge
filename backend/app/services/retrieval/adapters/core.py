from __future__ import annotations
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_PAGE_SIZE = 100  # CORE max per request


class CoreAdapter(DatabaseAdapter):
    name = "core"
    rate_limit = 10
    _BASE = "https://api.core.ac.uk/v3/search/works"

    async def search(self, query: str) -> list[Paper]:
        if not self._api_key:
            # CORE requires an API key — skip silently without one
            return []

        all_papers: list[Paper] = []
        offset = 0

        while True:
            headers = {"Authorization": f"Bearer {self._api_key}"}
            params = {
                "q": query,
                "limit": _PAGE_SIZE,
                "offset": offset,
            }

            async with self._semaphore:
                resp = await self._get_client().get(self._BASE, params=params, headers=headers)
                resp.raise_for_status()

            data = resp.json()
            total: int = data.get("totalHits", 0)
            results = data.get("results") or []
            batch = [self._normalize(r) for r in results]
            all_papers.extend(batch)

            offset += len(batch)
            if offset >= total or len(batch) == 0:
                break

        return all_papers

    def _normalize(self, r: dict) -> Paper:
        authors_raw = r.get("authors") or []
        authors = [
            Author(name=a.get("name", ""))
            for a in authors_raw
            if a.get("name")
        ]

        journals_raw = r.get("journals") or []
        journal = journals_raw[0].get("title") if journals_raw else None

        year_raw = r.get("yearPublished")
        year = int(year_raw) if year_raw else None

        pdf_url = r.get("downloadUrl") or (
            (r.get("sourceFulltextUrls") or [None])[0]
        )

        return Paper(
            doi=r.get("doi"),
            core_id=str(r.get("id")) if r.get("id") else None,
            title=r.get("title") or "",
            abstract=r.get("abstract"),
            year=year,
            authors=authors,
            journal=journal,
            venue=journal,
            is_open_access=True,  # CORE only indexes open access
            pdf_url=pdf_url,
            keywords=r.get("topics") or [],
            sources=["core"],
        )
