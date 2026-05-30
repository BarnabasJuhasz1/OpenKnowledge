from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class KeywordResult:
    keywords: list[str] = field(default_factory=list)
    method: str = "heuristic"  # "gemma" | "heuristic"
    model: str | None = None


class KeywordGenerator(ABC):
    """Pluggable strategy that turns a research description (+ optional bib
    context) into a list of academic search keywords."""

    @abstractmethod
    async def generate(self, prompt: str, bib_context: str = "") -> KeywordResult:
        ...


def keywords_to_query(keywords: list[str]) -> str:
    """Render keywords/query-groups as a query string for the search box.

    Handles both shapes the generators can return:
      - plain keyphrases ("model compression") → quoted if multi-word;
      - boolean query groups ('("LLM" OR "large language model")') → passed
        through untouched.
    Joined with AND. The frontend `parseQuery` strips operators/parentheses and
    keeps the quoted phrases, so either shape flattens to the right keywords.
    """
    parts: list[str] = []
    for kw in keywords:
        kw = kw.strip()
        if not kw:
            continue
        if '"' in kw or "(" in kw:
            parts.append(kw)            # already a query fragment / boolean group
        elif " " in kw:
            parts.append(f'"{kw}"')     # quote multi-word phrase
        else:
            parts.append(kw)
    return " AND ".join(parts)
