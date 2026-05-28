from __future__ import annotations
import asyncio
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_FIELDS = ",".join([
    "id", "doi", "title", "abstract_inverted_index",
    "authorships", "publication_year", "publication_date",
    "primary_location", "open_access", "cited_by_count",
    "referenced_works", "concepts", "keywords", "ids",
    "biblio", "type",
])

_PAGE_SIZE = 200  # OpenAlex max per-page


class OpenAlexAdapter(DatabaseAdapter):
    name = "openalex"
    rate_limit = 10
    _BASE = "https://api.openalex.org/works"

    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        all_papers: list[Paper] = []
        cursor: str = "*"

        while True:
            params: dict = {
                # Use title_and_abstract.search to match the OpenAlex website.
                # The `search` param also includes fulltext hits, which inflates
                # result counts far beyond what the website shows.
                "filter": f"title_and_abstract.search:{query}",
                "per-page": _PAGE_SIZE,
                "cursor": cursor,
                "select": _FIELDS,
            }
            if self._contact_email:
                params["mailto"] = self._contact_email

            resp = await self._request_with_retry("GET", self._BASE, params=params)

            data = resp.json()
            results = data.get("results", [])
            batch = [self._normalize(w) for w in results]
            all_papers.extend(batch)

            if max_results is not None and len(all_papers) >= max_results:
                all_papers = all_papers[:max_results]
                break

            next_cursor = data.get("meta", {}).get("next_cursor")
            if next_cursor is None or len(results) == 0:
                break
            cursor = next_cursor

            # Polite-pool delay (~10 req/s)
            await asyncio.sleep(0.15)

        return all_papers

    # ------------------------------------------------------------------
    def _reconstruct_abstract(self, inv: dict | None) -> str | None:
        if not inv:
            return None
        pos_word: dict[int, str] = {}
        for word, positions in inv.items():
            for p in positions:
                pos_word[p] = word
        return " ".join(pos_word[i] for i in sorted(pos_word))

    def _normalize(self, w: dict) -> Paper:
        authors = []
        for a in w.get("authorships", []):
            ad = a.get("author") or {}
            authors.append(Author(
                name=ad.get("display_name", ""),
                openalex_id=ad.get("id"),
                orcid=ad.get("orcid"),
                affiliations=[
                    i.get("display_name", "")
                    for i in a.get("institutions", [])
                    if i.get("display_name")
                ],
            ))

        loc = w.get("primary_location") or {}
        source = loc.get("source") or {}
        biblio = w.get("biblio") or {}
        ids = w.get("ids") or {}
        oa = w.get("open_access") or {}

        doi = (w.get("doi") or "").replace("https://doi.org/", "") or None
        arxiv_raw = ids.get("arxiv") or ""
        arxiv_id = arxiv_raw.replace("https://arxiv.org/abs/", "") or None

        fp = biblio.get("first_page")
        lp = biblio.get("last_page")
        pages = f"{fp}-{lp}" if fp and lp else fp

        return Paper(
            doi=doi,
            openalex_id=w.get("id"),
            arxiv_id=arxiv_id,
            title=w.get("title") or "",
            abstract=self._reconstruct_abstract(w.get("abstract_inverted_index")),
            year=w.get("publication_year"),
            publication_date=w.get("publication_date"),
            authors=authors,
            journal=source.get("display_name"),
            venue=source.get("display_name"),
            volume=biblio.get("volume"),
            issue=biblio.get("issue"),
            pages=pages,
            is_open_access=oa.get("is_oa", False),
            pdf_url=oa.get("oa_url"),
            landing_url=loc.get("landing_page_url"),
            citation_count=w.get("cited_by_count"),
            references=[
                r.replace("https://openalex.org/", "")
                for r in (w.get("referenced_works") or [])
            ],
            fields_of_study=[c.get("display_name", "") for c in (w.get("concepts") or [])],
            keywords=[k.get("display_name", "") for k in (w.get("keywords") or [])],
            sources=["openalex"],
        )
