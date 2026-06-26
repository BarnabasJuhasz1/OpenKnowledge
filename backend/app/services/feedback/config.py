"""Configuration for the in-app feedback feature.

Alpha testers submit bug reports (→ GitHub Issues) and feature requests
(→ GitHub Discussions) against a single target repository. Everything is read
from the environment so the feature can be enabled per-deployment without code
changes; when the token or repo are missing the feature simply reports itself as
disabled and the frontend hides its launcher.
"""
from __future__ import annotations

import os


def _clean(value: str | None) -> str | None:
    """Return a stripped value, or None when empty/whitespace."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def github_token() -> str | None:
    """PAT used to post issues/discussions.

    Prefers the dedicated ``FEEDBACK_GITHUB_TOKEN`` but falls back to the
    existing ``GITHUB_TOKEN`` so a single token can serve both the stars lookup
    and feedback submission. The token needs issue-write and discussion-write
    permission on the target repo.
    """
    return _clean(os.getenv("FEEDBACK_GITHUB_TOKEN")) or _clean(os.getenv("GITHUB_TOKEN"))


def repo_owner() -> str | None:
    return _clean(os.getenv("FEEDBACK_REPO_OWNER"))


def repo_name() -> str | None:
    return _clean(os.getenv("FEEDBACK_REPO_NAME"))


def discussion_category() -> str:
    """Discussion category name feature requests are filed under."""
    return _clean(os.getenv("FEEDBACK_DISCUSSION_CATEGORY")) or "Ideas"


def bug_labels() -> list[str]:
    """Labels applied to filed bug issues."""
    raw = _clean(os.getenv("FEEDBACK_BUG_LABELS")) or "bug"
    return [label.strip() for label in raw.split(",") if label.strip()]


def is_configured() -> bool:
    """True when feedback can actually be submitted (token + repo present)."""
    return bool(github_token() and repo_owner() and repo_name())
