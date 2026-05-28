from __future__ import annotations
import asyncio
import xml.etree.ElementTree as ET
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

_PAGE_SIZE = 200  # PubMed retmax


class PubMedAdapter(DatabaseAdapter):
    name = "pubmed"
    rate_limit = 3  # 10/s with key, 3/s without

    async def search(self, query: str, *, max_results: int | None = None) -> list[Paper]:
        all_papers: list[Paper] = []
        retstart = 0

        # Step 1 — single esearch to get count, WebEnv, and query_key
        search_params: dict = {
            "db": "pubmed",
            "term": query,
            "retmax": 0,
            "retmode": "json",
            "usehistory": "y",
        }
        if self._api_key:
            search_params["api_key"] = self._api_key

        search_resp = await self._request_with_retry("GET", _ESEARCH, params=search_params)

        search_data = search_resp.json().get("esearchresult") or {}
        total = int(search_data.get("count", 0))
        webenv = search_data.get("webenv")
        query_key = search_data.get("querykey")

        if total == 0 or not webenv or not query_key:
            return all_papers

        if max_results is not None:
            total = min(total, max_results)

        # Step 2 — paginate efetch using WebEnv/query_key
        while retstart < total:
            await asyncio.sleep(0.34)  # rate-limit: ~3 req/s without API key

            fetch_params: dict = {
                "db": "pubmed",
                "WebEnv": webenv,
                "query_key": query_key,
                "retstart": retstart,
                "retmax": _PAGE_SIZE,
                "rettype": "xml",
                "retmode": "xml",
            }
            if self._api_key:
                fetch_params["api_key"] = self._api_key

            fetch_resp = await self._request_with_retry("GET", _EFETCH, params=fetch_params)

            root = ET.fromstring(fetch_resp.text)
            batch = [self._normalize(art) for art in root.findall(".//PubmedArticle")]
            all_papers.extend(batch)

            retstart += _PAGE_SIZE
            if not batch:
                break

            if max_results is not None and len(all_papers) >= max_results:
                all_papers = all_papers[:max_results]
                break

        return all_papers

    def _normalize(self, art: ET.Element) -> Paper:
        def find_text(path: str) -> str | None:
            el = art.find(path)
            return el.text.strip() if el is not None and el is not None and el.text else None

        pmid = find_text(".//PMID")

        # Title
        title = find_text(".//ArticleTitle") or ""

        # Abstract — may have multiple AbstractText elements
        abstract_parts = [
            (el.text or "").strip()
            for el in art.findall(".//AbstractText")
            if el.text
        ]
        abstract = " ".join(abstract_parts) or None

        # Authors
        authors = []
        for author_el in art.findall(".//Author"):
            last = (author_el.findtext("LastName") or "").strip()
            first = (author_el.findtext("ForeName") or "").strip()
            name = f"{first} {last}".strip() if first or last else ""
            if not name:
                collective = author_el.findtext("CollectiveName")
                name = collective.strip() if collective else ""
            if name:
                affiliations = [
                    aff.text.strip()
                    for aff in author_el.findall(".//AffiliationInfo/Affiliation")
                    if aff.text
                ]
                authors.append(Author(name=name, affiliations=affiliations))

        # Journal
        journal = find_text(".//Journal/Title")
        volume = find_text(".//JournalIssue/Volume")
        issue = find_text(".//JournalIssue/Issue")

        # Date
        year_text = find_text(".//PubDate/Year")
        year = int(year_text) if year_text and year_text.isdigit() else None

        # Pages
        pages = find_text(".//MedlinePgn")

        # DOI
        doi = None
        for id_el in art.findall(".//ArticleId"):
            if id_el.get("IdType") == "doi" and id_el.text:
                doi = id_el.text.strip()

        # MeSH terms
        mesh_terms = [
            mh.findtext("DescriptorName") or ""
            for mh in art.findall(".//MeshHeading")
            if mh.findtext("DescriptorName")
        ]

        # Keywords
        keywords = [
            kw.text.strip()
            for kw in art.findall(".//Keyword")
            if kw.text
        ]

        return Paper(
            doi=doi,
            pubmed_id=pmid,
            title=title,
            abstract=abstract,
            year=year,
            authors=authors,
            journal=journal,
            venue=journal,
            volume=volume,
            issue=issue,
            pages=pages,
            mesh_terms=mesh_terms,
            keywords=keywords,
            is_peer_reviewed=True,  # PubMed indexes peer-reviewed literature
            sources=["pubmed"],
        )
