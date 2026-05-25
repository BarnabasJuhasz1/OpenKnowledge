from __future__ import annotations
import re
from ...models.paper import Paper

_NON_ALNUM = re.compile(r"[^a-zA-Z0-9]")


def _cite_key(paper: Paper) -> str:
    first_author = paper.authors[0].name.split()[-1] if paper.authors else "unknown"
    first_author = _NON_ALNUM.sub("", first_author).lower()
    year = str(paper.year) if paper.year else "0000"
    title_word = (paper.title.split()[0] if paper.title else "untitled").lower()
    title_word = _NON_ALNUM.sub("", title_word)
    return f"{first_author}{year}{title_word}"


def _entry_type(paper: Paper) -> str:
    # arXiv-only papers without a journal → misc
    if paper.arxiv_id and not paper.journal and not paper.venue:
        return "misc"
    if paper.journal:
        return "article"
    if paper.venue:
        return "inproceedings"
    return "misc"


def _field(name: str, value: str | None) -> str | None:
    if not value:
        return None
    # Escape special BibTeX characters
    value = value.replace("{", "\\{").replace("}", "\\}")
    return f"  {name:<14} = {{{value}}}"


def generate(paper: Paper) -> str:
    """Generate a BibTeX entry string from a Paper object."""
    if paper.bibtex:
        # Already have native BibTeX (e.g. from DBLP)
        return paper.bibtex

    etype = _entry_type(paper)
    key = _cite_key(paper)
    author_str = " and ".join(a.name for a in paper.authors) if paper.authors else "Unknown"

    fields_raw = [
        _field("title", paper.title),
        _field("author", author_str),
        _field("year", str(paper.year) if paper.year else None),
        _field("journal", paper.journal) if etype == "article" else None,
        _field("booktitle", paper.venue) if etype == "inproceedings" else None,
        _field("volume", paper.volume),
        _field("number", paper.issue),
        _field("pages", paper.pages),
        _field("publisher", paper.publisher),
        _field("doi", paper.doi),
        _field("url", paper.pdf_url or paper.landing_url),
        _field("eprint", paper.arxiv_id),
        _field("archivePrefix", "arXiv") if paper.arxiv_id else None,
        _field("primaryClass", paper.fields_of_study[0] if paper.fields_of_study else None) if paper.arxiv_id else None,
        _field("note", f"arXiv:{paper.arxiv_id}") if paper.arxiv_id and etype == "misc" else None,
    ]

    fields = "\n".join(f for f in fields_raw if f)
    return f"@{etype}{{{key},\n{fields}\n}}"


def attach_bibtex(papers: list[Paper]) -> list[Paper]:
    """Attach generated BibTeX to each paper in place."""
    for paper in papers:
        if not paper.bibtex:
            paper.bibtex = generate(paper)
    return papers
