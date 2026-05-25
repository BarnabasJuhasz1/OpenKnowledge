from __future__ import annotations
import xml.etree.ElementTree as ET
from ....models.paper import Paper, Author, PaperVersion
from .base import DatabaseAdapter

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

_PAGE_SIZE = 100  # arXiv max_results per request


class ArxivAdapter(DatabaseAdapter):
    name = "arxiv"
    rate_limit = 1  # arXiv requires ~3s between requests
    _BASE = "https://export.arxiv.org/api/query"

    async def search(self, query: str) -> list[Paper]:
        all_papers: list[Paper] = []
        start = 0

        while True:
            params = {
                "search_query": query,
                "start": start,
                "max_results": _PAGE_SIZE,
                "sortBy": "relevance",
                "sortOrder": "descending",
            }

            async with self._semaphore:
                resp = await self._get_client().get(self._BASE, params=params)
                resp.raise_for_status()

            root = ET.fromstring(resp.text)
            total_el = root.find("opensearch:totalResults", _NS)
            total = int(total_el.text) if total_el is not None and total_el.text else 0

            entries = root.findall("atom:entry", _NS)
            batch = [self._normalize(entry) for entry in entries]
            all_papers.extend(batch)

            start += len(batch)
            if start >= total or len(batch) == 0:
                break

        return all_papers

    def _normalize(self, entry: ET.Element) -> Paper:
        def text(tag: str, ns: str = "atom") -> str | None:
            el = entry.find(f"{ns}:{tag}", _NS)
            return el.text.strip() if el is not None and el.text else None

        raw_id = text("id") or ""
        # raw_id looks like http://arxiv.org/abs/2301.00001v2
        arxiv_id = raw_id.split("/abs/")[-1] if "/abs/" in raw_id else raw_id
        # base ID without version
        base_id = arxiv_id.split("v")[0] if "v" in arxiv_id else arxiv_id

        authors = [
            Author(name=a.find("atom:name", _NS).text.strip())
            for a in entry.findall("atom:author", _NS)
            if a.find("atom:name", _NS) is not None
        ]

        categories = [
            cat.get("term", "")
            for cat in entry.findall("atom:category", _NS)
        ]

        doi_el = entry.find("arxiv:doi", _NS)
        doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

        journal_ref_el = entry.find("arxiv:journal_ref", _NS)
        journal_ref = journal_ref_el.text.strip() if journal_ref_el is not None and journal_ref_el.text else None

        published = text("published")
        updated = text("updated")

        # Collect version history from links tagged as version
        versions: list[PaperVersion] = []
        for link in entry.findall("atom:link", _NS):
            if link.get("rel") == "related" and "v" in (link.get("href") or ""):
                pass  # arXiv API v1 doesn't expose individual version dates in search
        # At minimum record current version
        if arxiv_id != base_id:
            ver_str = arxiv_id.split("v")[-1] if "v" in arxiv_id else "1"
            versions.append(PaperVersion(version=f"v{ver_str}", submitted=updated or published or ""))

        pdf_url = f"https://arxiv.org/pdf/{base_id}"

        return Paper(
            doi=doi,
            arxiv_id=base_id,
            title=text("title") or "",
            abstract=(text("summary") or "").replace("\n", " "),
            publication_date=published,
            year=int(published[:4]) if published else None,
            authors=authors,
            journal=journal_ref,
            fields_of_study=categories,
            is_open_access=True,
            pdf_url=pdf_url,
            landing_url=f"https://arxiv.org/abs/{base_id}",
            versions=versions if versions else None,
            sources=["arxiv"],
        )
