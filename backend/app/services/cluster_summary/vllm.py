"""vLLM-backed cluster summarization over the OpenAI streaming protocol.

Streams a chat completion token-by-token so the API can forward deltas to the UI
as Server-Sent Events (kills perceived latency). The model is prompted to emit
plain text — the title on the first line, then the summary — so the title arrives
first and the rest streams naturally. Parsing is line-based with a tolerant JSON
fallback in case the model still wraps its answer in JSON.

Kept thin and swappable (see CLAUDE.md): build the request, stream the deltas,
raise LLMError on any problem so the orchestrator can fall back deterministically.
"""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

from openai import OpenAIError

from .. import llm_client
from ..llm_client import LLMError
from .config import temperature, max_output_tokens

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_LABEL_RE = re.compile(r"^\s*(?:title|summary)\s*[:\-]\s*", re.IGNORECASE)


class VLLMClusterSummarizer:
    """One streaming chat completion per cluster."""

    async def stream(self, system_prompt: str, user_content: str) -> AsyncIterator[str]:
        client = llm_client.vllm_client()
        try:
            stream = await client.chat.completions.create(
                model=llm_client.vllm_model(),
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=temperature(),
                max_tokens=max_output_tokens(),
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    yield delta
        except OpenAIError as e:
            raise LLMError(f"vLLM request failed: {e}") from e
        except Exception as e:  # transport / unexpected SDK errors
            raise LLMError(f"vLLM stream error: {e}") from e


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


def parse_title_summary(text: str) -> tuple[str, str]:
    """Extract (title, summary) from the streamed model output.

    Primary format is plain text: the first non-empty line is the title and the
    remaining lines are the summary. We tolerate optional ``Title:`` / ``Summary:``
    labels, and fall back to the LAST embedded JSON object carrying a
    title/summary in case the model ignored the instruction and emitted JSON. A
    single-line response is treated as the summary (no title). Returns empty
    strings when nothing usable is found so the caller falls back deterministically.
    """
    cleaned = _FENCE_RE.sub("", text or "").strip()
    if not cleaned:
        return "", ""

    # Tolerant JSON fallback first only if the whole thing parses as a JSON object.
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and (parsed.get("summary") or parsed.get("title")):
            return str(parsed.get("title", "")).strip(), str(parsed.get("summary", "")).strip()
    except json.JSONDecodeError:
        pass

    lines = cleaned.splitlines()
    nonempty_idx = next((i for i, ln in enumerate(lines) if ln.strip()), None)
    if nonempty_idx is None:
        return "", ""

    title = _LABEL_RE.sub("", lines[nonempty_idx].strip()).strip().strip('"').strip()
    rest = "\n".join(lines[nonempty_idx + 1:]).strip()
    summary = _LABEL_RE.sub("", rest).strip() if rest else ""

    if not summary:
        # Only one line of content — embedded JSON, or treat it as the summary.
        for obj in reversed(_extract_json_objects(cleaned)):
            if obj.get("summary") or obj.get("title"):
                return str(obj.get("title", "")).strip(), str(obj.get("summary", "")).strip()
        return "", title

    return title, summary
