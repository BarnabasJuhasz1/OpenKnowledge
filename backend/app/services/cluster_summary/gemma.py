"""Gemma-backed cluster summarization via the Google Generative Language API.

Mirrors services/keywords/gemma.py: one HTTP call, strict JSON parsing, raises on
any problem so the orchestrator can fall back to a deterministic summary. Kept
thin and swappable, anticipating future support for local models.
"""
from __future__ import annotations

import json
import os
import re

import httpx

from .base import ClusterSummaryResult
from .config import temperature, max_output_tokens

_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_DEFAULT_MODEL = "gemma-4-26b-a4b-it"
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class GemmaError(RuntimeError):
    pass


class GemmaClusterSummarizer:
    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or os.getenv("GEMMA_MODEL", _DEFAULT_MODEL)

    async def summarize(self, system_prompt: str, user_content: str) -> ClusterSummaryResult:
        url = f"{_API_BASE}/{self.model}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": f"{system_prompt}\n\n{user_content}"}]}],
            "generationConfig": {
                "temperature": temperature(),
                "maxOutputTokens": max_output_tokens(),
                "thinkingConfig": {
                    "thinkingBudget": 0
                }
            },
        }
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(url, params={"key": self.api_key}, json=payload)
            resp.raise_for_status()
            data = resp.json()
            parts = data["candidates"][0]["content"]["parts"]
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
            raise GemmaError(f"Gemma request failed: {e}") from e

        text = _answer_text(parts)
        if not text:
            # The whole budget went to reasoning ("thought") parts — the answer
            # was truncated away. Let the caller fall back rather than parse
            # the model's thinking.
            raise GemmaError("Gemma returned only reasoning, no answer")

        title, summary = _parse_summary(text)
        if not summary:
            raise GemmaError("Gemma returned no usable summary")
        return ClusterSummaryResult(
            title=title, summary=summary, method="gemma", model=self.model
        )


def _answer_text(parts: list[dict]) -> str:
    """Join the model's *answer* parts, skipping reasoning.

    The Generative Language API returns the response as a list of parts; for
    thinking-style Gemma models the chain-of-thought parts are flagged
    `"thought": true` and must be ignored — the actual answer lives in the
    remaining part(s). Reading `parts[0]` blindly would surface the reasoning.
    """
    answer = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    return answer.strip()


def _extract_json_objects(text: str) -> list[dict]:
    """Every valid JSON object embedded anywhere in the text, in order."""
    decoder = json.JSONDecoder()
    found: list[dict] = []
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            found.append(obj)
    return found


def _field_value(text: str, field: str) -> str:
    """Pull the LAST `field` value out of prose the model emits when it ignores
    the JSON instruction (e.g. `Summary: ...` or `* "title": "..."`). Reasoning
    models narrate first and put the real answer last, so the last match wins."""
    # Quoted (JSON-ish) value, possibly embedded in prose.
    quoted = re.findall(rf'["\']?{field}["\']?\s*[:=]\s*"((?:[^"\\]|\\.)*)"', text, re.IGNORECASE)
    if quoted:
        try:
            return quoted[-1].encode().decode("unicode_escape").strip()
        except (UnicodeDecodeError, ValueError):
            return quoted[-1].strip()
    # Markdown / bullet "Field: value" on its own line.
    line = re.findall(rf'(?:^|\n)[ \t>*#\-]*["\']?{field}["\']?\s*[:=]\s*(.+)', text, re.IGNORECASE)
    if line:
        return line[-1].strip().strip('"\'').strip()
    return ""


def _parse_summary(text: str) -> tuple[str, str]:
    """Extract (title, summary) from the model output.

    Gemma reasoning models narrate their thinking and wrap (or omit) the JSON,
    so we degrade in steps: (1) a clean JSON parse; (2) the LAST embedded JSON
    object carrying a title/summary; (3) the LAST `Title:` / `Summary:` fields
    found in the prose. If none yields a summary we return empty so the caller
    falls back to a clean deterministic summary rather than dumping the model's
    reasoning monologue.
    """
    cleaned = _FENCE_RE.sub("", text).strip()

    obj: dict | None = None
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            obj = parsed
    except json.JSONDecodeError:
        for candidate in reversed(_extract_json_objects(cleaned)):
            if "summary" in candidate or "title" in candidate:
                obj = candidate
                break

    if obj is not None:
        title = str(obj.get("title", "")).strip()
        summary = str(obj.get("summary", "")).strip()
        if summary:
            return title, summary

    # Prose fallback for narrated / non-JSON output.
    return _field_value(cleaned, "title"), _field_value(cleaned, "summary")
