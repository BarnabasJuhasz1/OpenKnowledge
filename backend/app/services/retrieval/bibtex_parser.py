"""Lightweight, dependency-free BibTeX parsing.

Only what we need to feed dropped .bib files to the keyword generator as
context: titles, abstracts and keyword fields. Tolerant of malformed input.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Locates the start of each `@type{` entry; the body runs until the next entry.
_ENTRY_START_RE = re.compile(r"@(\w+)\s*\{", re.DOTALL)
# `field = {value}` or `field = "value"` or `field = value,`
_FIELD_RE = re.compile(
    r'(\w+)\s*=\s*(?:\{(.*?)\}|"(.*?)"|([^,\n]+))\s*,?',
    re.DOTALL,
)
_WS = re.compile(r"\s+")


@dataclass
class BibEntry:
    entry_type: str = "misc"
    title: str | None = None
    abstract: str | None = None
    author: str | None = None
    year: str | None = None
    keywords: list[str] = field(default_factory=list)


def _clean(value: str) -> str:
    # Drop wrapping braces and collapse whitespace.
    value = value.replace("{", "").replace("}", "")
    return _WS.sub(" ", value).strip()


def parse_bibtex(text: str) -> list[BibEntry]:
    """Parse BibTeX text into a list of entries. Never raises on bad input."""
    entries: list[BibEntry] = []
    if not text:
        return entries

    starts = list(_ENTRY_START_RE.finditer(text))
    for i, match in enumerate(starts):
        entry_type = match.group(1).lower()
        # Body runs from after `@type{` to the start of the next entry (or EOF).
        body_start = match.end()
        body_end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        body = text[body_start:body_end]
        # Skip the cite key (text before the first comma) when scanning fields.
        fields: dict[str, str] = {}
        for fm in _FIELD_RE.finditer(body):
            name = fm.group(1).lower()
            raw = fm.group(2) or fm.group(3) or fm.group(4) or ""
            fields[name] = _clean(raw)

        kw_raw = fields.get("keywords", "")
        keywords = [
            k.strip()
            for k in re.split(r"[;,]", kw_raw)
            if k.strip()
        ]
        entries.append(
            BibEntry(
                entry_type=entry_type,
                title=fields.get("title") or None,
                abstract=fields.get("abstract") or None,
                author=fields.get("author") or None,
                year=fields.get("year") or None,
                keywords=keywords,
            )
        )
    return entries


def bib_context_text(entries: list[BibEntry], max_entries: int = 20) -> str:
    """Compact text block summarising bib entries for an LLM prompt."""
    lines: list[str] = []
    for entry in entries[:max_entries]:
        if not entry.title and not entry.keywords:
            continue
        parts = []
        if entry.title:
            parts.append(f"Title: {entry.title}")
        if entry.keywords:
            parts.append(f"Keywords: {', '.join(entry.keywords)}")
        if entry.abstract:
            parts.append(f"Abstract: {entry.abstract[:300]}")
        lines.append(" | ".join(parts))
    return "\n".join(lines)


def collect_keywords(entries: list[BibEntry]) -> list[str]:
    """All distinct keyword-field terms across entries (order-preserving)."""
    seen: set[str] = set()
    out: list[str] = []
    for entry in entries:
        for kw in entry.keywords:
            low = kw.lower()
            if low not in seen:
                seen.add(low)
                out.append(kw)
    return out
