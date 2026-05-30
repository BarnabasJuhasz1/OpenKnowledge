"""Gemma-backed keyword generation via the Google Generative Language API.

Kept deliberately thin and swappable (see CLAUDE.md): one HTTP call, strict JSON
parsing, and it raises on any problem so the orchestrator can fall back to the
local heuristic.
"""
from __future__ import annotations

import json
import os
import re

import httpx

from .base import KeywordGenerator, KeywordResult
from .config import system_prompt, temperature, max_output_tokens

_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_DEFAULT_MODEL = "gemma-4-26b-a4b-it"
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class GemmaError(RuntimeError):
    pass


class GemmaKeywordGenerator(KeywordGenerator):
    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or os.getenv("GEMMA_MODEL", _DEFAULT_MODEL)

    async def generate(self, prompt: str, bib_context: str = "") -> KeywordResult:
        user = f"Research description:\n{prompt.strip()}"
        if bib_context.strip():
            user += f"\n\nContext papers the researcher finds relevant:\n{bib_context.strip()}"

        url = f"{_API_BASE}/{self.model}:generateContent"
        payload = {
            "contents": [{"parts": [{"text": f"{system_prompt()}\n\n{user}"}]}],
            "generationConfig": {
                "temperature": temperature(),
                "maxOutputTokens": max_output_tokens(),
            },
        }
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    url, params={"key": self.api_key}, json=payload
                )
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
            raise GemmaError(f"Gemma request failed: {e}") from e

        keywords = _parse_keywords(text)
        if not keywords:
            raise GemmaError("Gemma returned no usable keywords")
        return KeywordResult(keywords=keywords[:12], method="gemma", model=self.model)


def _try_json_array(text: str) -> list[str] | None:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    items = [str(x).strip() for x in parsed if str(x).strip()]
    return items or None


def _extract_json_arrays(text: str) -> list[list[str]]:
    """Every valid JSON string-array embedded anywhere in the text, in order."""
    decoder = json.JSONDecoder()
    found: list[list[str]] = []
    for i, ch in enumerate(text):
        if ch != "[":
            continue
        try:
            obj, _ = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, list):
            items = [str(x).strip() for x in obj if str(x).strip()]
            if items:
                found.append(items)
    return found


def _parse_keywords(text: str) -> list[str]:
    """Extract the JSON array of keyphrases / query groups.

    Gemma 4 reasoning models narrate their thinking and embed the array inside
    prose (often after earlier example arrays), so we scan for every valid JSON
    array and take the LAST one (the final answer). If none is found we return
    nothing — the caller then falls back to the local heuristic rather than
    emitting the model's prose as bogus keywords.
    """
    cleaned = _FENCE_RE.sub("", text).strip()

    items = _try_json_array(cleaned)
    if items:
        return items

    arrays = _extract_json_arrays(cleaned)
    return arrays[-1] if arrays else []
