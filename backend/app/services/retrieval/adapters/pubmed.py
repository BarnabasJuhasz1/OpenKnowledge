from __future__ import annotations
import xml.etree.ElementTree as ET
from ....models.paper import Paper, Author
from .base import DatabaseAdapter

_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

_PAGE_SIZE = 200  # PubMed retmax


class PubMedAdapter(DatabaseAdapter):
    name = "pubmed"
    rate_limit = 3  # 10/s with key, 3/s without

    async def search(self, query: str) -> list[Paper]:
        all_papers: list[Paper] = []
        retstart = 0

        while True:
            # Step 1 — get PMIDs
            search_params: dict = {
                "db": "pubmed",
                "term": query,
                "retmax": _PAGE_SIZE,
                "retstart": retstart,
                "retmode": "json",
                "usehistory": "n",
            }
            if self._api_key:
                search_params["api_key"] = self._api_key

            async with self._semaphore:
                search_resp = await self._get_client().get(_ESEARCH, params=search_params)
                search_resp.raise_for_status()

            search_data = search_resp.json().get("esearchresult") or {}
            total = int(search_data.get("count", 0))
            pmids: list[str] = search_data.get("idlist") or []

            if not pmids:
                break

            # Step 2 — fetch full records for those PMIDs
            fetch_params: dict = {
                "db": "pubmed",
                "id": ",".join(pmids),
                "rettype": "xml",
                "retmode": "xml",
            }
            if self._api_key:
                fetch_params["api_key"] = self._api_key

            async with self._semaphore:
                fetch_resp = await self._get_client().get(_EFETCH, params=fetch_params)
                fetch_resp.raise_for_status()

            root = ET.fromstring(fetch_resp.text)
            batch = [self._normalize(art) for art in root.findall(".//PubmedArticle")]
            all_papers.extend(batch)

            retstart += len(pmids)
            if retstart >= total:
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
