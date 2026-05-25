"""Utility for stripping boolean syntax from queries.

APIs like Semantic Scholar and CrossRef don't support boolean operators
(AND, OR, NOT) or parentheses. This module provides helpers to convert
standard boolean queries into plain keyword searches.
"""
from __future__ import annotations

import re


_BOOLEAN_OPERATORS = {"AND", "OR", "NOT"}


def strip_boolean_syntax(raw: str) -> str:
    """Strip AND/OR/NOT operators and parentheses, preserving quoted phrases.

    Examples:
        >>> strip_boolean_syntax('"large language model" AND LLM')
        '"large language model" LLM'
        >>> strip_boolean_syntax('("large language model" OR LLM) AND compression')
        '"large language model" LLM compression'
        >>> strip_boolean_syntax('LLM NOT RAG')
        'LLM RAG'
    """
    # Extract quoted phrases first to protect them
    quoted_phrases: list[str] = re.findall(r'"[^"]*"', raw)

    # Replace quoted phrases with placeholders
    working = raw
    for i, phrase in enumerate(quoted_phrases):
        working = working.replace(phrase, f"__QUOTED_{i}__", 1)

    # Strip parentheses
    working = working.replace("(", " ").replace(")", " ")

    # Tokenize and remove boolean operators
    tokens = working.split()
    filtered = [t for t in tokens if t not in _BOOLEAN_OPERATORS]

    # Restore quoted phrases
    result_tokens: list[str] = []
    for token in filtered:
        match = re.match(r"__QUOTED_(\d+)__", token)
        if match:
            idx = int(match.group(1))
            result_tokens.append(quoted_phrases[idx])
        else:
            result_tokens.append(token)

    return " ".join(result_tokens)


def has_boolean_operators(raw: str) -> bool:
    """Check if a query string contains boolean operators (AND, OR, NOT)."""
    tokens = raw.split()
    return any(t in _BOOLEAN_OPERATORS for t in tokens)
