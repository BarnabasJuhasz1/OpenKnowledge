"""Keyword generation: vLLM when configured, local heuristic otherwise."""
from __future__ import annotations

from .base import KeywordGenerator, KeywordResult, keywords_to_query
from .heuristic import HeuristicKeywordGenerator
from .vllm import VLLMKeywordGenerator
from ..llm_client import LLMError, vllm_enabled

__all__ = [
    "KeywordGenerator",
    "KeywordResult",
    "keywords_to_query",
    "generate_keywords",
]


async def generate_keywords(prompt: str, bib_context: str = "") -> KeywordResult:
    """Generate keywords, preferring the vLLM model and falling back to the heuristic.

    The fallback keeps the feature working for free/offline use and whenever the
    LLM call errors out.
    """
    if vllm_enabled():
        try:
            return await VLLMKeywordGenerator().generate(prompt, bib_context)
        except LLMError:
            pass  # fall through to heuristic
    return await HeuristicKeywordGenerator().generate(prompt, bib_context)
