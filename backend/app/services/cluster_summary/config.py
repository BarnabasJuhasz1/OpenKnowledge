"""Tweakable configuration for AI cluster summarization.

The two gemma instructions live in editable text files (no code change needed):
    backend/prompts/finest_cluster_summary.txt
    backend/prompts/high_level_cluster_summary.txt
Override their locations with the FINEST_CLUSTER_PROMPT_FILE /
HIGH_LEVEL_CLUSTER_PROMPT_FILE env vars. Generation knobs are read from env so
they can be tuned in backend/.env (temperature is shared with keyword
generation; the token budget is summary-specific).
"""
from __future__ import annotations

import os
from pathlib import Path

# .../backend/app/services/cluster_summary/config.py -> .../backend
_BACKEND_ROOT = Path(__file__).resolve().parents[3]
_PROMPTS = _BACKEND_ROOT / "prompts"
_DEFAULT_FINEST_FILE = _PROMPTS / "finest_cluster_summary.txt"
_DEFAULT_HIGH_FILE = _PROMPTS / "high_level_cluster_summary.txt"

# Used only if a prompt file is missing/empty, so the feature never breaks.
_FALLBACK_FINEST = (
    "You are a research assistant analyzing one cluster of academic papers. "
    "Given each paper's title, archetypes, and abstract, identify the common "
    "technical thread connecting them and explain why they are grouped together. "
    "Respond with ONLY a valid JSON object: "
    '{"title": "<short title>", "summary": "<~100 word summary>"}'
)
_FALLBACK_HIGH = (
    "You are a research assistant analyzing a higher-level cluster. Given the "
    "title and summary of each finer sub-cluster, identify the common technical "
    "thread that unifies them and explain why they belong together. Respond with "
    'ONLY a valid JSON object: {"title": "<short title>", "summary": "<~100 word summary>"}'
)


def _read(path: Path, fallback: str) -> str:
    try:
        text = path.read_text(encoding="utf-8").strip()
        if text:
            return text
    except OSError:
        pass
    return fallback


def finest_prompt() -> str:
    """Read the editable finest-cluster instruction; re-read each call."""
    path = Path(os.getenv("FINEST_CLUSTER_PROMPT_FILE", str(_DEFAULT_FINEST_FILE)))
    return _read(path, _FALLBACK_FINEST)


def high_level_prompt() -> str:
    """Read the editable higher-level instruction; re-read each call."""
    path = Path(os.getenv("HIGH_LEVEL_CLUSTER_PROMPT_FILE", str(_DEFAULT_HIGH_FILE)))
    return _read(path, _FALLBACK_HIGH)


def temperature() -> float:
    try:
        return float(os.getenv("GEMMA_TEMPERATURE", "0.3"))
    except ValueError:
        return 0.3


def max_output_tokens() -> int:
    # Reasoning-style Gemma models narrate before answering, so give enough
    # headroom that the final JSON / "Summary:" line is not truncated away.
    try:
        return int(os.getenv("CLUSTER_SUMMARY_MAX_TOKENS", "2048"))
    except ValueError:
        return 2048
