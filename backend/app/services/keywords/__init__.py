"""Keyword generation: Gemma when configured, local heuristic otherwise."""
from __future__ import annotations

import os

from .base import KeywordGenerator, KeywordResult, keywords_to_query
from .heuristic import HeuristicKeywordGenerator
from .gemma import GemmaKeywordGenerator, GemmaError

__all__ = [
    "KeywordGenerator",
    "KeywordResult",
    "keywords_to_query",
    "generate_keywords",
]


async def generate_keywords(prompt: str, bib_context: str = "") -> KeywordResult:
    """Generate keywords, preferring Gemma and falling back to the heuristic.

    The fallback keeps the feature working for free/offline use and whenever the
    LLM call errors out.
    """
    api_key = os.getenv("GOOGLE_API_KEY")
    if api_key:
        try:
            return await GemmaKeywordGenerator(api_key).generate(prompt, bib_context)
        except GemmaError:
            pass  # fall through to heuristic
    return await HeuristicKeywordGenerator().generate(prompt, bib_context)
