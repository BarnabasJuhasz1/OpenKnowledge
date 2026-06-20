from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PaperInput:
    """A single paper feeding a finest-cluster summary."""
    title: str
    abstract: str = ""
    archetypes: list[str] = field(default_factory=list)


@dataclass
class ChildInput:
    """A child sub-cluster's summary feeding a higher-level summary."""
    title: str
    summary: str


@dataclass
class SiblingInput:
    """A compact structural fingerprint of a sibling cluster at the same level.

    Provides contrastive context (no generated summary, so it is available before
    the level is summarized) so the model can highlight what makes the current
    cluster distinct from the others it sits alongside.
    """
    title: str
    size: int = 0
    archetypes: list[str] = field(default_factory=list)


@dataclass
class ClusterSummaryResult:
    title: str
    summary: str
    # Up to 3 short note-style keyword phrases for a fast glance at the cluster.
    bullets: list[str] = field(default_factory=list)
    method: str = "fallback"  # "vllm" | "fallback"
    model: str | None = None
