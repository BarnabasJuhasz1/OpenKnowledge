from __future__ import annotations
import hashlib
import json
import time
from ...models.paper import Paper

_DEFAULT_TTL = 60 * 60 * 24 * 7  # 7 days


class InMemoryCache:
    """Simple TTL cache keyed by (db_name, query, page)."""

    def __init__(self, ttl: int = _DEFAULT_TTL):
        self._ttl = ttl
        self._store: dict[str, tuple[float, list[Paper], int]] = {}

    def _key(self, db: str, query: str, page: int) -> str:
        raw = f"{db}:{query}:{page}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, db: str, query: str, page: int) -> tuple[list[Paper], int] | None:
        k = self._key(db, query, page)
        entry = self._store.get(k)
        if entry is None:
            return None
        ts, papers, total = entry
        if time.time() - ts > self._ttl:
            del self._store[k]
            return None
        return papers, total

    def set(self, db: str, query: str, page: int, papers: list[Paper], total: int) -> None:
        k = self._key(db, query, page)
        self._store[k] = (time.time(), papers, total)

    def clear(self) -> None:
        self._store.clear()


# Module-level singleton — shared across requests within one process
cache = InMemoryCache()
