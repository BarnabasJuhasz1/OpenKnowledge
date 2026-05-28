from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
)

def _now() -> datetime:
    return datetime.now(timezone.utc)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


class DBPaper(Base):
    __tablename__ = "papers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doi: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    arxiv_id: Mapped[str | None] = mapped_column(String, index=True)
    semantic_scholar_id: Mapped[str | None] = mapped_column(String, index=True)
    openalex_id: Mapped[str | None] = mapped_column(String, index=True)
    pubmed_id: Mapped[str | None] = mapped_column(String, index=True)
    dblp_key: Mapped[str | None] = mapped_column(String)
    core_id: Mapped[str | None] = mapped_column(String)

    title: Mapped[str] = mapped_column(Text, nullable=False)
    abstract: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    publication_date: Mapped[str | None] = mapped_column(String)

    journal: Mapped[str | None] = mapped_column(String)
    venue: Mapped[str | None] = mapped_column(String)
    volume: Mapped[str | None] = mapped_column(String)
    issue: Mapped[str | None] = mapped_column(String)
    pages: Mapped[str | None] = mapped_column(String)
    publisher: Mapped[str | None] = mapped_column(String)
    issn: Mapped[str | None] = mapped_column(String)
    isbn: Mapped[str | None] = mapped_column(String)

    is_open_access: Mapped[bool] = mapped_column(Boolean, default=False)
    pdf_url: Mapped[str | None] = mapped_column(String)
    landing_url: Mapped[str | None] = mapped_column(String)

    citation_count: Mapped[int | None] = mapped_column(Integer)
    reference_count: Mapped[int | None] = mapped_column(Integer)

    is_peer_reviewed: Mapped[bool | None] = mapped_column(Boolean)
    has_public_code: Mapped[bool | None] = mapped_column(Boolean)
    code_url: Mapped[str | None] = mapped_column(String)
    has_dataset: Mapped[bool] = mapped_column(Boolean, default=False)
    repo_stars: Mapped[int] = mapped_column(Integer, default=0)

    bibtex: Mapped[str | None] = mapped_column(Text)
    sources: Mapped[str | None] = mapped_column(String)  # comma-separated

    retrieved_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now
    )

    authors: Mapped[list[DBPaperAuthor]] = relationship(
        back_populates="paper", cascade="all, delete-orphan",
        order_by="DBPaperAuthor.position", lazy="selectin",
    )
    keywords: Mapped[list[DBPaperKeyword]] = relationship(
        back_populates="paper", cascade="all, delete-orphan", lazy="selectin",
    )
    versions: Mapped[list[DBPaperVersion]] = relationship(
        back_populates="paper", cascade="all, delete-orphan", lazy="selectin",
    )
    references: Mapped[list[DBPaperReference]] = relationship(
        foreign_keys="DBPaperReference.citing_paper_id",
        back_populates="citing_paper",
        cascade="all, delete-orphan", lazy="selectin",
    )


class DBAuthor(Base):
    __tablename__ = "authors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    openalex_id: Mapped[str | None] = mapped_column(String, unique=True)
    orcid: Mapped[str | None] = mapped_column(String)

    paper_links: Mapped[list[DBPaperAuthor]] = relationship(back_populates="author")


class DBPaperAuthor(Base):
    __tablename__ = "paper_authors"
    __table_args__ = (UniqueConstraint("paper_id", "position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    affiliations: Mapped[str | None] = mapped_column(Text)  # JSON-encoded list

    paper: Mapped[DBPaper] = relationship(back_populates="authors")
    author: Mapped[DBAuthor] = relationship(back_populates="paper_links")


class DBPaperKeyword(Base):
    __tablename__ = "paper_keywords"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    keyword: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(String)  # 'keyword' | 'mesh' | 'field_of_study' | 'arxiv_category'

    paper: Mapped[DBPaper] = relationship(back_populates="keywords")


class DBPaperReference(Base):
    __tablename__ = "paper_references"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    citing_paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    cited_identifier: Mapped[str] = mapped_column(String)  # DOI or openalex ID of cited paper

    citing_paper: Mapped[DBPaper] = relationship(
        foreign_keys=[citing_paper_id], back_populates="references"
    )


class DBPaperVersion(Base):
    __tablename__ = "paper_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id"), index=True)
    version: Mapped[str] = mapped_column(String)
    submitted_at: Mapped[str] = mapped_column(String)
    diff_summary: Mapped[str | None] = mapped_column(Text)

    paper: Mapped[DBPaper] = relationship(back_populates="versions")


class DBShelfItem(Base):
    __tablename__ = "shelf_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    query_text: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    use_count: Mapped[int] = mapped_column(Integer, default=1)


class DBBookshelfItem(Base):
    __tablename__ = "bookshelf_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_identifier: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    authors_json: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    paper_json: Mapped[str | None] = mapped_column(Text)  # full Paper snapshot for the detail view
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class DBPaperNote(Base):
    """Notes kept independently of the bookshelf so they survive remove/re-add."""

    __tablename__ = "paper_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_identifier: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class DBRetrievalJob(Base):
    __tablename__ = "retrieval_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    query_text: Mapped[str] = mapped_column(Text)
    keywords: Mapped[str] = mapped_column(Text)       # JSON
    databases_used: Mapped[str] = mapped_column(Text) # JSON
    n_results: Mapped[int | None] = mapped_column(Integer)
    failed_sources: Mapped[str | None] = mapped_column(Text)  # JSON
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
