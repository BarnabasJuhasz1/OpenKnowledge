from __future__ import annotations

import ast
import logging
import re
from pathlib import Path

import pandas as pd

from ...models.paper import Author, Paper

logger = logging.getLogger(__name__)

CSV_PATH = Path(__file__).resolve().parents[4] / "database" / "mock_papers.csv"

_NAME_RE = re.compile(r"'([^']+)'")


def _parse_authors(raw: str) -> list[Author]:
    if not raw or raw == "[]":
        return []
    return [Author(name=m) for m in _NAME_RE.findall(raw)]


def _parse_references(raw: str) -> list[str]:
    if not raw or raw == "[]":
        return []
    try:
        refs = ast.literal_eval(raw)
        return [r for r in refs if isinstance(r, str)]
    except Exception:
        return []


class DemoDataStore:
    _instance: DemoDataStore | None = None

    def __init__(self) -> None:
        self._df: pd.DataFrame | None = None

    @classmethod
    def get(cls) -> DemoDataStore:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _ensure_loaded(self) -> pd.DataFrame:
        if self._df is not None:
            return self._df

        logger.info("Loading demo papers from %s …", CSV_PATH)
        df = pd.read_csv(
            CSV_PATH,
            dtype={
                "id": str,
                "title": str,
                "abstract": str,
                "authors": str,
                "venue": str,
                "year": "Int64",
                "n_citation": "Int64",
                "references": str,
            },
            keep_default_na=False,
        )
        df["_title_lc"] = df["title"].str.lower()
        df["_abstract_lc"] = df["abstract"].str.lower()
        self._df = df
        logger.info("Demo store ready: %d papers", len(df))
        return df

    def search(self, keywords: list[str], limit: int = 200) -> list[Paper]:
        df = self._ensure_loaded()

        mask = pd.Series(True, index=df.index)
        for kw in keywords:
            kw_lower = kw.lower()
            mask &= (
                df["_title_lc"].str.contains(kw_lower, regex=False)
                | df["_abstract_lc"].str.contains(kw_lower, regex=False)
            )

        matched = df[mask].nlargest(limit, "n_citation", keep="first")
        return [self._row_to_paper(row) for _, row in matched.iterrows()]

    @staticmethod
    def _row_to_paper(row: pd.Series) -> Paper:
        refs = _parse_references(row["references"])
        citation_count = int(row["n_citation"]) if row["n_citation"] else None

        return Paper(
            semantic_scholar_id=str(row["id"]),
            title=row["title"],
            abstract=row["abstract"] or None,
            year=int(row["year"]) if row["year"] else None,
            venue=row["venue"] or None,
            authors=_parse_authors(row["authors"]),
            citation_count=citation_count,
            reference_count=len(refs) if refs else None,
            references=refs,
            referenced_by=[],
            sources=["demo"],
        )
