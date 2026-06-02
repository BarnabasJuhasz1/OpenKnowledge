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
class ClusterSummaryResult:
    title: str
    summary: str
    method: str = "fallback"  # "gemma" | "fallback"
    model: str | None = None
