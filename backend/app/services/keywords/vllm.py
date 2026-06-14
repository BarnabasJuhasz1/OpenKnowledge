"""vLLM-backed keyword generation over the OpenAI protocol.

Non-streaming: the keyword array is consumed whole to build a search query, so a
single completion is simpler than streaming. Kept thin and swappable (see
CLAUDE.md): one call, strict JSON-array parsing, raises LLMError on any problem so
the orchestrator can fall back to the local heuristic.
"""
from __future__ import annotations

import json
import re

from openai import OpenAIError

from .base import KeywordGenerator, KeywordResult
from .config import system_prompt, temperature, max_output_tokens
from .. import llm_client
from ..llm_client import LLMError

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class VLLMKeywordGenerator(KeywordGenerator):
    async def generate(self, prompt: str, bib_context: str = "") -> KeywordResult:
        user = f"Research description:\n{prompt.strip()}"
        if bib_context.strip():
            user += f"\n\nContext papers the researcher finds relevant:\n{bib_context.strip()}"

        client = llm_client.vllm_client()
        try:
            resp = await client.chat.completions.create(
                model=llm_client.vllm_model(),
                messages=[
                    {"role": "system", "content": system_prompt()},
                    {"role": "user", "content": user},
                ],
                temperature=temperature(),
                max_tokens=max_output_tokens(),
                stream=False,
            )
            text = resp.choices[0].message.content or ""
        except (OpenAIError, IndexError, AttributeError) as e:
            raise LLMError(f"vLLM request failed: {e}") from e

        keywords = _parse_keywords(text)
        if not keywords:
            raise LLMError("vLLM returned no usable keywords")
        return KeywordResult(keywords=keywords[:12], method="vllm", model=llm_client.vllm_model())


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

    Instruction-tuned models occasionally wrap the array in prose or emit an
    earlier example array, so we scan for every valid JSON array and take the LAST
    one (the final answer). If none is found we return nothing — the caller then
    falls back to the local heuristic rather than emitting prose as bogus keywords.
    """
    cleaned = _FENCE_RE.sub("", text).strip()

    items = _try_json_array(cleaned)
    if items:
        return items

    arrays = _extract_json_arrays(cleaned)
    return arrays[-1] if arrays else []
