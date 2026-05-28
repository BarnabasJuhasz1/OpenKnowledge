from __future__ import annotations
import asyncio
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_PAGE_SIZE = 100  # DBLP max per request


class DblpAdapter(DatabaseAdapter):
    name = "dblp"
    rate_limit = 10
    _request_delay = 0.1
    _BASE = "https://dblp.org/search/publ/api"

    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        all_papers: list[Paper] = []
        offset = 0
        # DBLP API hard-limits to 10,000 results
        cap = min(max_results, 10000) if max_results is not None else 10000

        while offset < cap:
            params = {
                "q": query,
                "format": "json",
                "h": min(_PAGE_SIZE, cap - offset),
                "f": offset,
            }

            resp = await self._request_with_retry("GET", self._BASE, params=params)

            data = resp.json()
            result = data.get("result") or {}
            hits_data = result.get("hits") or {}
            total = int(hits_data.get("@total", 0))
            hits = hits_data.get("hit") or []

            batch = [self._normalize(h.get("info") or {}, h.get("@id", "")) for h in hits]
            all_papers.extend(batch)

            offset += len(batch)
            if offset >= total or len(batch) == 0 or offset >= cap:
                break

            await asyncio.sleep(self._request_delay)

        return all_papers

    def _normalize(self, info: dict, hit_id: str) -> Paper:
        authors_raw = info.get("authors") or {}
        author_list = authors_raw.get("author") or []
        if isinstance(author_list, dict):
            author_list = [author_list]
        authors = [
            Author(name=a.get("text", a) if isinstance(a, dict) else str(a))
            for a in author_list
        ]

        doi = (info.get("doi") or "").replace("https://doi.org/", "") or None

        # DBLP type: Journal_Articles, Conference_and_Workshop_Papers, etc.
        pub_type = info.get("type") or ""
        is_peer_reviewed = pub_type in (
            "Journal Articles", "Conference and Workshop Papers"
        )

        year_raw = info.get("year")
        year = int(year_raw) if year_raw and str(year_raw).isdigit() else None

        # Native BibTeX key from DBLP
        dblp_key = info.get("key")

        venue = info.get("venue")
        journal = venue if "journal" in pub_type.lower() else None
        conference = venue if "conference" in pub_type.lower() else None

        return Paper(
            doi=doi,
            dblp_key=dblp_key,
            title=info.get("title") or "",
            year=year,
            authors=authors,
            journal=journal,
            venue=conference or venue,
            is_peer_reviewed=is_peer_reviewed,
            landing_url=info.get("url"),
            sources=["dblp"],
        )

    async def fetch_bibtex(self, dblp_key: str) -> str | None:
        """Fetch native BibTeX from DBLP for a given key."""
        url = f"https://dblp.org/rec/{dblp_key}.bib"
        try:
            resp = await self._request_with_retry("GET", url)
            return resp.text
        except Exception:
            return None
