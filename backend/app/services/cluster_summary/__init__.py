"""Cluster summarization: streaming vLLM when configured, deterministic fallback.

Stateless, per-cluster. The frontend drives the bottom-up order (finest clusters
first, then higher levels fed the previous layer's summaries) and the progress
indicator; this module turns one cluster's inputs into a stream of {title,
summary} deltas, emitted as a sequence of events the API forwards over SSE.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from .base import PaperInput, ChildInput, SiblingInput, ClusterSummaryResult
from .config import finest_prompt, high_level_prompt
from .vllm import VLLMClusterSummarizer, parse_summary
from ..llm_client import LLMError, vllm_enabled, vllm_model

__all__ = [
    "PaperInput",
    "ChildInput",
    "SiblingInput",
    "ClusterSummaryResult",
    "stream_cluster_summary",
]


def _truncate(text: str, n: int = 60) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _sibling_block(siblings: list[SiblingInput]) -> str:
    """Render a compact roster of sibling clusters at the same level.

    Empty string when there are no siblings, so single-cluster levels add no
    overhead. Each line is one structural fingerprint (label, size, dominant
    archetypes) — enough for the model to contrast against without sending whole
    abstracts or (unavailable) sibling summaries.
    """
    if not siblings:
        return ""
    lines = [
        "",
        f"Other clusters at this same level ({len(siblings)}). Make THIS cluster's "
        "summary distinct from them — emphasize its specific focus, method, or "
        "sub-problem and do not restate themes that apply equally to these:",
    ]
    for i, s in enumerate(siblings, 1):
        archetypes = ", ".join(a for a in s.archetypes if a) or "n/a"
        count = f"{s.size} paper{'' if s.size == 1 else 's'}"
        lines.append(f"{i}. {s.title or 'Untitled'} ({count}; archetypes: {archetypes})")
    return "\n".join(lines)


def _finest_user(papers: list[PaperInput], name: str, siblings: list[SiblingInput]) -> str:
    lines: list[str] = []
    if name:
        lines.append(f"Cluster label: {name}")
    lines.append(f"Papers in this cluster ({len(papers)}):")
    for i, p in enumerate(papers, 1):
        archetypes = ", ".join(a for a in p.archetypes if a) or "n/a"
        abstract = (p.abstract or "").strip() or "n/a"
        lines.append(
            f"{i}. Title: {p.title}\n"
            f"   Archetypes: {archetypes}\n"
            f"   Abstract: {abstract}"
        )
    block = _sibling_block(siblings)
    if block:
        lines.append(block)
    return "\n".join(lines)


def _higher_user(children: list[ChildInput], name: str, siblings: list[SiblingInput]) -> str:
    lines: list[str] = []
    if name:
        lines.append(f"Cluster label: {name}")
    lines.append(f"Finer sub-cluster summaries ({len(children)}):")
    for i, c in enumerate(children, 1):
        lines.append(f"{i}. {c.title or 'Untitled'} — {c.summary}")
    block = _sibling_block(siblings)
    if block:
        lines.append(block)
    return "\n".join(lines)


def _fallback(
    kind: str,
    papers: list[PaperInput],
    children: list[ChildInput],
    name: str,
) -> ClusterSummaryResult:
    """Deterministic summary so the feature degrades gracefully offline / on error."""
    if kind == "finest":
        titles = [p.title for p in papers if p.title][:3]
        count = len(papers)
        summary = (
            f"A group of {count} related paper{'' if count == 1 else 's'}. "
            f"Representative works: {'; '.join(titles)}."
            if titles
            else f"A group of {count} related papers."
        )
    else:
        titles = [c.title or "Untitled" for c in children][:3]
        count = len(children)
        summary = (
            f"A broader area grouping {count} sub-cluster{'' if count == 1 else 's'}: "
            f"{'; '.join(titles)}."
        )
    title = name or _truncate(titles[0]) if (name or titles) else "Cluster"
    # Up to 3 glanceable bullets from the representative titles, so the bullet UI
    # is never empty when the LLM is unavailable.
    bullets = [_truncate(t, 50) for t in titles[:3]]
    return ClusterSummaryResult(title=title, summary=summary, bullets=bullets, method="fallback")


def _done_event(result: ClusterSummaryResult) -> dict:
    return {
        "done": True,
        "title": result.title,
        "summary": result.summary,
        "bullets": result.bullets,
        "method": result.method,
        "model": result.model,
    }


async def stream_cluster_summary(
    kind: str,
    *,
    papers: list[PaperInput] | None = None,
    children: list[ChildInput] | None = None,
    siblings: list[SiblingInput] | None = None,
    name: str = "",
) -> AsyncIterator[dict]:
    """Stream one cluster's summary as a sequence of events.

    Yields ``{"delta": str}`` for each text chunk, then a terminal
    ``{"done": True, "title", "summary", "method", "model"}`` carrying the
    authoritative parse. Always finishes with a coherent summary: if vLLM is
    unconfigured, unreachable, or returns nothing usable, it falls back to a
    deterministic summary so the feature degrades gracefully.
    """
    papers = papers or []
    children = children or []
    siblings = siblings or []

    if kind == "finest":
        system, user = finest_prompt(), _finest_user(papers, name, siblings)
    else:
        system, user = high_level_prompt(), _higher_user(children, name, siblings)

    fallback = _fallback(kind, papers, children, name)

    if not vllm_enabled():
        yield {"delta": fallback.summary}
        yield _done_event(fallback)
        return

    buf: list[str] = []
    try:
        async for delta in VLLMClusterSummarizer().stream(system, user):
            buf.append(delta)
            yield {"delta": delta}
    except LLMError:
        if not buf:
            # Nothing streamed — emit the fallback so the client shows something.
            yield {"delta": fallback.summary}
            yield _done_event(fallback)
            return
        # Partial output already streamed; finalize whatever we got below.

    title, summary, bullets = parse_summary("".join(buf))
    if not summary:
        yield _done_event(fallback)
        return

    yield _done_event(
        ClusterSummaryResult(
            title=title or fallback.title,
            summary=summary,
            bullets=bullets or fallback.bullets,
            method="vllm",
            model=vllm_model(),
        )
    )
