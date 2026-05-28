from __future__ import annotations
import re
import asyncio
import xml.etree.ElementTree as ET
import httpx
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

_PAGE_SIZE = 100  # arXiv max_results per request


_SS_CONCURRENCY = 5
_SS_BASE = "https://api.semanticscholar.org/graph/v1/paper/arXiv:"


async def _fetch_citation_count(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    paper: Paper,
) -> None:
    if not paper.arxiv_id:
        return
    url = f"{_SS_BASE}{paper.arxiv_id}?fields=citationCount"
    try:
        async with semaphore:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                count = data.get("citationCount")
                if count is not None:
                    paper.citation_count = count
    except Exception:
        pass


async def enrich_arxiv_citations(papers: list[Paper]) -> None:
    if not papers:
        return
    semaphore = asyncio.Semaphore(_SS_CONCURRENCY)
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
        tasks = [_fetch_citation_count(client, semaphore, p) for p in papers]
        await asyncio.gather(*tasks, return_exceptions=True)


class ArxivAdapter(DatabaseAdapter):
    name = "arxiv"
    rate_limit = 1  # arXiv requires ~3s between requests
    _request_delay = 3.0  # arXiv requires ~3s between requests
    _BASE = "https://export.arxiv.org/api/query"
    _DEFAULT_MAX = 10000  # reasonable default cap (was 500!)

    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        cap = max_results if max_results is not None else self._DEFAULT_MAX
        all_papers: list[Paper] = []
        start = 0

        while start < cap:
            page_size = min(_PAGE_SIZE, cap - start)
            params = {
                "search_query": f"all:{query}",
                "start": start,
                "max_results": page_size,
                "sortBy": "relevance",
                "sortOrder": "descending",
            }

            resp = await self._request_with_retry("GET", self._BASE, params=params)

            root = ET.fromstring(resp.text)

            # Check total results
            total_el = root.find("opensearch:totalResults", _NS)
            total = int(total_el.text) if total_el is not None and total_el.text else 0
            if total == 0:
                break

            entries = root.findall("atom:entry", _NS)
            if not entries:
                break

            for entry in entries:
                paper = self._parse_entry(entry)
                if paper:
                    all_papers.append(paper)

            start += len(entries)
            if start >= total or start >= cap:
                break

            # Rate limit: arXiv requires ~3s between requests
            await asyncio.sleep(self._request_delay)

        await enrich_arxiv_citations(all_papers)
        return all_papers

    def _parse_entry(self, entry: ET.Element) -> Paper | None:
        """Parse a single Atom entry into a Paper."""
        title_el = entry.find("atom:title", _NS)
        title = (title_el.text or "").strip().replace("\n", " ") if title_el is not None else ""
        if not title:
            return None

        summary_el = entry.find("atom:summary", _NS)
        abstract = (summary_el.text or "").strip().replace("\n", " ") if summary_el is not None else None

        # Extract arXiv ID from the <id> element (URL like http://arxiv.org/abs/XXXX.XXXXX)
        id_el = entry.find("atom:id", _NS)
        full_id = id_el.text.strip() if id_el is not None and id_el.text else ""
        arxiv_id = full_id.split("/abs/")[-1] if "/abs/" in full_id else full_id
        # Strip version suffix (e.g. v1, v2) for the canonical ID
        base_id = re.sub(r"v\d+$", "", arxiv_id)

        # DOI
        doi_el = entry.find("arxiv:doi", _NS)
        doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

        # Published date
        pub_el = entry.find("atom:published", _NS)
        published_str = pub_el.text.strip() if pub_el is not None and pub_el.text else None
        year = None
        if published_str:
            try:
                year = int(published_str[:4])
            except (ValueError, IndexError):
                pass

        # Authors
        authors = []
        for author_el in entry.findall("atom:author", _NS):
            name_el = author_el.find("atom:name", _NS)
            if name_el is not None and name_el.text:
                authors.append(Author(name=name_el.text.strip()))

        # Categories
        categories = []
        for cat_el in entry.findall("atom:category", _NS):
            term = cat_el.get("term")
            if term:
                categories.append(term)

        # Links
        pdf_url = None
        for link_el in entry.findall("atom:link", _NS):
            if link_el.get("title") == "pdf":
                pdf_url = link_el.get("href")
                break
        if not pdf_url and base_id:
            pdf_url = f"https://arxiv.org/pdf/{base_id}"

        landing_url = f"https://arxiv.org/abs/{base_id}" if base_id else None

        # Journal reference
        journal_el = entry.find("arxiv:journal_ref", _NS)
        journal = journal_el.text.strip() if journal_el is not None and journal_el.text else None

        return Paper(
            doi=doi,
            arxiv_id=base_id,
            title=title,
            abstract=abstract,
            publication_date=published_str,
            year=year,
            authors=authors,
            journal=journal,
            fields_of_study=categories,
            is_open_access=True,
            pdf_url=pdf_url,
            landing_url=landing_url,
            sources=["arxiv"],
        )
