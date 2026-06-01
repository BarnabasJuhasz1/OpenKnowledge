"""Cluster summarization: Gemma when configured, deterministic fallback otherwise.

Stateless, per-cluster. The frontend drives the bottom-up order (finest clusters
first, then higher levels fed the previous layer's summaries) and the progress
indicator; this module just turns one cluster's inputs into a {title, summary}.
"""
from __future__ import annotations

import os

from .base import PaperInput, ChildInput, ClusterSummaryResult
from .config import finest_prompt, high_level_prompt
from .gemma import GemmaClusterSummarizer, GemmaError

__all__ = [
    "PaperInput",
    "ChildInput",
    "ClusterSummaryResult",
    "summarize_cluster",
]


def _truncate(text: str, n: int = 60) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _finest_user(papers: list[PaperInput], name: str) -> str:
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
    return "\n".join(lines)


def _higher_user(children: list[ChildInput], name: str) -> str:
    lines: list[str] = []
    if name:
        lines.append(f"Cluster label: {name}")
    lines.append(f"Finer sub-cluster summaries ({len(children)}):")
    for i, c in enumerate(children, 1):
        lines.append(f"{i}. {c.title or 'Untitled'} — {c.summary}")
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
    return ClusterSummaryResult(title=title, summary=summary, method="fallback")


async def summarize_cluster(
    kind: str,
    *,
    papers: list[PaperInput] | None = None,
    children: list[ChildInput] | None = None,
    name: str = "",
) -> ClusterSummaryResult:
    papers = papers or []
    children = children or []

    if kind == "finest":
        system, user = finest_prompt(), _finest_user(papers, name)
    else:
        system, user = high_level_prompt(), _higher_user(children, name)

    api_key = os.getenv("GOOGLE_API_KEY")
    if api_key:
        try:
            result = await GemmaClusterSummarizer(api_key).summarize(system, user)
            if not result.title:
                result.title = _fallback(kind, papers, children, name).title
            return result
        except GemmaError:
            pass  # fall through to the deterministic fallback

    return _fallback(kind, papers, children, name)
