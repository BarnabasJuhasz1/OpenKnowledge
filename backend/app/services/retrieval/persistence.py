from __future__ import annotations
import json
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from ...models.paper import Paper
from ...db.orm_models import (
    DBAuthor, DBPaper, DBPaperAuthor, DBPaperKeyword,
    DBPaperReference, DBPaperVersion, DBRetrievalJob,
    DBShelfItem, DBBookshelfItem, DBPaperNote,
)


async def _delete_papers_for_project(session: AsyncSession, project_id: int) -> None:
    """Delete a project's papers and their child rows (no commit)."""
    paper_ids = (
        await session.execute(
            select(DBPaper.id).where(DBPaper.project_id == project_id)
        )
    ).scalars().all()
    if paper_ids:
        for child in (DBPaperReference, DBPaperVersion, DBPaperKeyword, DBPaperAuthor):
            pid_col = (
                child.citing_paper_id
                if child is DBPaperReference
                else child.paper_id
            )
            await session.execute(delete(child).where(pid_col.in_(paper_ids)))
        await session.execute(delete(DBPaper).where(DBPaper.id.in_(paper_ids)))


async def flush_all(session: AsyncSession, project_id: int) -> None:
    """Delete a project's papers, related data, and retrieval jobs."""
    await _delete_papers_for_project(session, project_id)
    await session.execute(
        delete(DBRetrievalJob).where(DBRetrievalJob.project_id == project_id)
    )
    await session.commit()


async def delete_project_data(session: AsyncSession, project_id: int) -> None:
    """Remove every record owned by a project (used when deleting a project)."""
    await _delete_papers_for_project(session, project_id)
    await session.execute(
        delete(DBRetrievalJob).where(DBRetrievalJob.project_id == project_id)
    )
    await session.execute(
        delete(DBShelfItem).where(DBShelfItem.project_id == project_id)
    )
    await session.execute(
        delete(DBBookshelfItem).where(DBBookshelfItem.project_id == project_id)
    )
    await session.execute(
        delete(DBPaperNote).where(DBPaperNote.project_id == project_id)
    )
    await session.commit()


async def upsert_papers(
    session: AsyncSession, papers: list[Paper], project_id: int
) -> None:
    """Persist papers to the database, upserting on DOI within the project."""
    for paper in papers:
        await _upsert_paper(session, paper, project_id)
    await session.commit()


async def _upsert_paper(
    session: AsyncSession, paper: Paper, project_id: int
) -> DBPaper:
    # Try to find an existing record within this project
    scope = lambda stmt: stmt.where(DBPaper.project_id == project_id)
    db_paper: DBPaper | None = None
    if paper.doi:
        result = await session.execute(scope(select(DBPaper).where(DBPaper.doi == paper.doi)))
        db_paper = result.scalar_one_or_none()
    if db_paper is None and paper.arxiv_id:
        result = await session.execute(scope(select(DBPaper).where(DBPaper.arxiv_id == paper.arxiv_id)))
        db_paper = result.scalar_one_or_none()
    if db_paper is None and paper.semantic_scholar_id:
        result = await session.execute(scope(select(DBPaper).where(DBPaper.semantic_scholar_id == paper.semantic_scholar_id)))
        db_paper = result.scalar_one_or_none()

    is_new = db_paper is None
    if is_new:
        db_paper = DBPaper(project_id=project_id)
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
    _set_if_empty("predicted_main_archetype", paper.predicted_main_archetype)
    _set_if_empty("predicted_second_tier_archetype", paper.predicted_second_tier_archetype)

    # has_dataset: True wins
    if paper.has_dataset:
        db_paper.has_dataset = True

    # repo_stars: take the max
    if paper.repo_stars > (db_paper.repo_stars or 0):
        db_paper.repo_stars = paper.repo_stars
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
    project_id: int,
) -> DBRetrievalJob:
    job = DBRetrievalJob(
        project_id=project_id,
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
