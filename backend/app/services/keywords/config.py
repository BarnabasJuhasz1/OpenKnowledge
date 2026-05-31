"""Tweakable configuration for AI keyword generation.

The Gemma instruction lives in an editable text file (no code change needed):
    backend/prompts/keyword_extraction.txt
Override its location with the KEYWORD_PROMPT_FILE env var. Generation knobs are
read from env so they can be tuned in backend/.env.
"""
from __future__ import annotations

import os
from pathlib import Path

# .../backend/app/services/keywords/config.py -> .../backend
_BACKEND_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_PROMPT_FILE = _BACKEND_ROOT / "prompts" / "keyword_extraction.txt"

# Used only if the prompt file is missing/empty, so the feature never breaks.
_FALLBACK_SYSTEM = (
"You are a strict data extraction system for academic literature databases. "
"Given a researcher's description, generate an optimized boolean search query array. "
"Use established terminology and multi-word technical phrases. "
"You MUST respond with ONLY a valid JSON array of strings containing the query groups. Do not include prose, conversational text, or explanations.\n\n"
"Example Input: I want to know about model compression techniques for large language models, specifically about pruning\n"
"Example Output: [\"(\\\"Large Language Model\\\" OR \\\"LLM\\\")\", \"(\\\"compression\\\" OR \\\"pruning\\\")\"]\n\n"
"Example Input: Give me papers about hyperbolic neural networks for graph classification\n"
"Example Output: [\"(\\\"hyperbolic neural network\\\" OR \\\"hyperbolic geometry\\\")\", \"(\\\"graph classification\\\" OR \\\"graph neural network\\\")\"]\n"
)


def system_prompt() -> str:
    """Read the editable instruction; re-read each call so edits apply live."""
    path = Path(os.getenv("KEYWORD_PROMPT_FILE", str(_DEFAULT_PROMPT_FILE)))
    try:
        text = path.read_text(encoding="utf-8").strip()
        if text:
            return text
    except OSError:
        pass
    return _FALLBACK_SYSTEM


def temperature() -> float:
    try:
        return float(os.getenv("GEMMA_TEMPERATURE", "0.2"))
    except ValueError:
        return 0.2


def max_output_tokens() -> int:
    try:
        return int(os.getenv("GEMMA_MAX_TOKENS", "512"))
    except ValueError:
        return 512
