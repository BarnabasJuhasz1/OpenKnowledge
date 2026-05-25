from __future__ import annotations
import json
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from ...models.paper import Paper
from ...db.orm_models import (
    DBAuthor, DBPaper, DBPaperAuthor, DBPaperKeyword,
    DBPaperReference, DBPaperVersion, DBRetrievalJob,
)


async def flush_all(session: AsyncSession) -> None:
    """Delete all papers and related data from the database."""
    await session.execute(delete(DBPaperReference))
    await session.execute(delete(DBPaperVersion))
    await session.execute(delete(DBPaperKeyword))
    await session.execute(delete(DBPaperAuthor))
    await session.execute(delete(DBPaper))
    await session.execute(delete(DBRetrievalJob))
    await session.commit()


async def upsert_papers(session: AsyncSession, papers: list[Paper]) -> None:
    """Persist papers to the database, upserting on DOI."""
    for paper in papers:
        await _upsert_paper(session, paper)
    await session.commit()


async def _upsert_paper(session: AsyncSession, paper: Paper) -> DBPaper:
    # Try to find existing record
    db_paper: DBPaper | None = None
    if paper.doi:
        result = await session.execute(select(DBPaper).where(DBPaper.doi == paper.doi))
        db_paper = result.scalar_one_or_none()
    if db_paper is None and paper.arxiv_id:
        result = await session.execute(select(DBPaper).where(DBPaper.arxiv_id == paper.arxiv_id))
        db_paper = result.scalar_one_or_none()
    if db_paper is None and paper.semantic_scholar_id:
        result = await session.execute(select(DBPaper).where(DBPaper.semantic_scholar_id == paper.semantic_scholar_id))
        db_paper = result.scalar_one_or_none()

    is_new = db_paper is None
    if is_new:
        db_paper = DBPaper()
        session.add(db_paper)

    # Only fill in fields that are currently None (never overwrite with lower-quality data)
    def _set_if_empty(attr: str, value) -> None:
        if value is not None and getattr(db_paper, attr) is None:
            setattr(db_paper, attr, value)

    _set_if_empty("doi", paper.doi)
    _set_if_empty("arxiv_id", paper.arxiv_id)
    _set_if_empty("semantic_scholar_id", paper.semantic_scholar_id)
    _set_if_empty("openalex_id", paper.openalex_id)
    _set_if_empty("pubmed_id", paper.pubmed_id)
    _set_if_empty("dblp_key", paper.dblp_key)
    _set_if_empty("core_id", paper.core_id)
    _set_if_empty("title", paper.title)
    _set_if_empty("abstract", paper.abstract)
    _set_if_empty("year", paper.year)
    _set_if_empty("publication_date", paper.publication_date)
    _set_if_empty("journal", paper.journal)
    _set_if_empty("venue", paper.venue)
    _set_if_empty("volume", paper.volume)
    _set_if_empty("issue", paper.issue)
    _set_if_empty("pages", paper.pages)
    _set_if_empty("publisher", paper.publisher)
    _set_if_empty("issn", paper.issn)
    _set_if_empty("isbn", paper.isbn)
    _set_if_empty("pdf_url", paper.pdf_url)
    _set_if_empty("landing_url", paper.landing_url)
    _set_if_empty("citation_count", paper.citation_count)
    _set_if_empty("reference_count", paper.reference_count)
    _set_if_empty("is_peer_reviewed", paper.is_peer_reviewed)
    _set_if_empty("has_public_code", paper.has_public_code)
    _set_if_empty("code_url", paper.code_url)
    _set_if_empty("bibtex", paper.bibtex)

    # is_open_access: True wins
    if paper.is_open_access:
        db_paper.is_open_access = True

    # Sources: merge
    existing_sources = set((db_paper.sources or "").split(",")) - {""}
    db_paper.sources = ",".join(sorted(existing_sources | set(paper.sources)))

    await session.flush()  # get db_paper.id

    # For new records only — avoids triggering async lazy-load on existing relationships
    if is_new:
        if paper.authors:
            for pos, author in enumerate(paper.authors):
                db_author = await _get_or_create_author(session, author)
                session.add(DBPaperAuthor(
                    paper_id=db_paper.id,
                    author_id=db_author.id,
                    position=pos,
                    affiliations=json.dumps(author.affiliations),
                ))

        for kw in paper.keywords:
            session.add(DBPaperKeyword(paper_id=db_paper.id, keyword=kw, source="keyword"))
        for kw in paper.mesh_terms:
            session.add(DBPaperKeyword(paper_id=db_paper.id, keyword=kw, source="mesh"))
        for kw in paper.fields_of_study:
            session.add(DBPaperKeyword(paper_id=db_paper.id, keyword=kw, source="field_of_study"))

        for ref_id in paper.references:
            session.add(DBPaperReference(citing_paper_id=db_paper.id, cited_identifier=ref_id))

        if paper.versions:
            for v in paper.versions:
                session.add(DBPaperVersion(
                    paper_id=db_paper.id,
                    version=v.version,
                    submitted_at=v.submitted,
                ))

    return db_paper


async def _get_or_create_author(session: AsyncSession, author) -> DBAuthor:
    if author.openalex_id:
        result = await session.execute(
            select(DBAuthor).where(DBAuthor.openalex_id == author.openalex_id)
        )
        db_author = result.scalar_one_or_none()
        if db_author:
            return db_author

    result = await session.execute(select(DBAuthor).where(DBAuthor.name == author.name))
    db_author = result.scalar_one_or_none()
    if db_author:
        return db_author

    db_author = DBAuthor(
        name=author.name,
        openalex_id=author.openalex_id,
        orcid=author.orcid,
    )
    session.add(db_author)
    await session.flush()
    return db_author


async def save_job(
    session: AsyncSession,
    keywords: list[str],
    databases: list[str],
    n_results: int,
    failed_sources: list[str],
) -> DBRetrievalJob:
    job = DBRetrievalJob(
        query_text=" ".join(keywords),
        keywords=json.dumps(keywords),
        databases_used=json.dumps(databases),
        n_results=n_results,
        failed_sources=json.dumps(failed_sources),
        completed_at=datetime.now(timezone.utc),
    )
    session.add(job)
    await session.commit()
    return job
