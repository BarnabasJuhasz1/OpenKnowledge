"""Shared vLLM client over the OpenAI-compatible protocol.

The backend and the model server run on separate GCP instances, so the client is
configured entirely from env. Kept deliberately thin and swappable (see
CLAUDE.md): one factory, one error type. Both LLM features (cluster summaries and
keyword generation) build their requests on top of this and fall back to a
deterministic path whenever the model is unreachable.

Env contract:
    VLLM_BASE_URL     OpenAI base URL of the vLLM server, incl. /v1
                      (unset -> features use their deterministic fallback)
    VLLM_API_KEY      bearer token vLLM expects (default "EMPTY")
    VLLM_MODEL_NAME   served model id (default "default")
    VLLM_TEMPERATURE  sampling temperature (per-feature default)
"""
from __future__ import annotations

import os

from openai import AsyncOpenAI


class LLMError(RuntimeError):
    """Raised on any model/transport problem so callers can fall back."""


def vllm_enabled() -> bool:
    """True when a vLLM endpoint is configured; gates whether we call the model."""
    return bool(os.getenv("VLLM_BASE_URL", "").strip())


def vllm_client() -> AsyncOpenAI:
    """Build an async OpenAI client pointed at the internal vLLM endpoint.

    Not cached so tests can monkeypatch this symbol and so env changes apply
    live. vLLM accepts any non-empty api_key; "EMPTY" is the conventional default.
    """
    return AsyncOpenAI(
        base_url=os.getenv("VLLM_BASE_URL", "").strip() or None,
        api_key=os.getenv("VLLM_API_KEY", "EMPTY") or "EMPTY",
    )


def vllm_model() -> str:
    return os.getenv("VLLM_MODEL_NAME", "default")


def llm_temperature(default: float) -> float:
    """Shared sampling temperature (VLLM_TEMPERATURE), falling back to the legacy
    GEMMA_TEMPERATURE so existing .env files keep working."""
    raw = os.getenv("VLLM_TEMPERATURE") or os.getenv("GEMMA_TEMPERATURE")
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def llm_max_tokens(env_var: str, default: int) -> int:
    raw = os.getenv(env_var) or os.getenv("VLLM_MAX_TOKENS")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default
