"""Process-wide cache of archetype classifications.

Classification depends only on a paper's abstract and is served by a remote model, so the
round trip is the expensive part. Caching the result by a stable paper key lets a re-run
(e.g. after a Scholar filter change, which restarts the classify stream) reuse results
instead of re-classifying papers that were already done — and lets the page endpoint look
up an archetype for a paper the OpenSearch index doesn't carry one on.

Keys: the Scholar ``corpusid`` when present (so the page endpoint, which only has the id,
can look papers up), else a hash of the abstract (so duplicate abstracts share a result).
A cached ``(None, None)`` means "classified, no archetype" and still counts as a hit, so an
abstract that genuinely classifies to nothing is never re-sent to the model.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from threading import Lock
from typing import Any

# Bound memory: a simple FIFO eviction keeps the table from growing without limit across a
# long-lived process. 200k entries is far more than any single query's navigable window.
_MAX_ENTRIES = 200_000

_CACHE: "OrderedDict[str, tuple[str | None, str | None]]" = OrderedDict()
_LOCK = Lock()


def corpusid_key(corpusid: Any) -> str:
    """Cache key for a Scholar corpusid (the page endpoint's only handle on a paper)."""
    return f"c:{corpusid}"


def paper_cache_key(obj: Any) -> str | None:
    """Stable cache key for a Paper/node: corpusid if present, else an abstract hash.

    Returns ``None`` for objects with neither, which therefore can't be cached.
    """
    cid = getattr(obj, "semantic_scholar_id", None)
    if cid:
        return corpusid_key(cid)
    abstract = getattr(obj, "abstract", None)
    if abstract and str(abstract).strip():
        digest = hashlib.sha1(str(abstract).strip().encode("utf-8")).hexdigest()
        return f"a:{digest}"
    # Title-only fallback: abstract-less papers are classified from their title, so key
    # them by a title hash when there's no corpusid to key on.
    title = getattr(obj, "title", None)
    if title and str(title).strip():
        digest = hashlib.sha1(str(title).strip().encode("utf-8")).hexdigest()
        return f"t:{digest}"
    return None


def get(key: str | None) -> tuple[str | None, str | None] | None:
    """Cached ``(primary, secondary)`` for ``key``, or ``None`` on a miss."""
    if not key:
        return None
    with _LOCK:
        return _CACHE.get(key)


def put(key: str | None, primary: str | None, secondary: str | None) -> None:
    """Cache a classification result, evicting the oldest entries when full."""
    if not key:
        return
    with _LOCK:
        if key not in _CACHE and len(_CACHE) >= _MAX_ENTRIES:
            # Drop the oldest ~10% in one pass so eviction isn't paid on every insert.
            for _ in range(_MAX_ENTRIES // 10):
                _CACHE.popitem(last=False)
        _CACHE[key] = (primary, secondary)


def clear() -> None:
    """Drop every cached entry (used by tests)."""
    with _LOCK:
        _CACHE.clear()
