from __future__ import annotations

import asyncio
import logging
import pickle
import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .citgraph_builder import CitGraphEdge, CitGraphNode, CitGraphResult

logger = logging.getLogger(__name__)

_HERE = Path(__file__).resolve()
CSV_PATH = _HERE.parents[4] / "database" / "demo_papers.csv"
CACHE_PATH = _HERE.parents[4] / "database" / "demo_citgraph_index.pkl"

# Bump when the on-disk index layout changes so stale caches are rebuilt.
_CACHE_VERSION = 3

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
_NAME_RE = re.compile(r"'([^']+)'")


@dataclass
class _Index:
    forward: dict[str, list[str]]   # paper id -> ids it references (cites)
    reverse: dict[str, list[str]]   # paper id -> ids that cite it
    meta: dict[str, dict]           # paper id -> metadata row
    title_to_id: dict[str, str]     # lowercased exact title -> paper id


def _parse_authors(raw: str) -> list[str]:
    if not raw or raw == "[]":
        return []
    return _NAME_RE.findall(raw)


def _to_int(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class DemoCitGraphStore:
    """Builds citation graphs from the local demo dataset (no external calls).

    The index is expensive to build from the 1M-row CSV (~45s), so it is cached
    to ``demo_citgraph_index.pkl`` and reloaded (~10s) whenever the cache is at
    least as new as the CSV. Loading/building happens in a worker thread so the
    async event loop stays responsive, guarded by a lock to avoid concurrent
    rebuilds.
    """

    _instance: DemoCitGraphStore | None = None

    def __init__(self) -> None:
        self._index: _Index | None = None
        self._lock = asyncio.Lock()

    @classmethod
    def get(cls) -> DemoCitGraphStore:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _ensure_loaded(self) -> _Index:
        if self._index is not None:
            return self._index
        async with self._lock:
            if self._index is None:
                self._index = await asyncio.to_thread(self._load_or_build)
        return self._index

    def _load_or_build(self) -> _Index:
        if (
            CACHE_PATH.exists()
            and CACHE_PATH.stat().st_mtime >= CSV_PATH.stat().st_mtime
        ):
            try:
                with open(CACHE_PATH, "rb") as fh:
                    blob = pickle.load(fh)
                if blob.get("version") == _CACHE_VERSION:
                    logger.info(
                        "Loaded demo citgraph index from cache (%d papers)",
                        len(blob["meta"]),
                    )
                    return _Index(
                        blob["forward"],
                        blob["reverse"],
                        blob["meta"],
                        blob["title_to_id"],
                    )
                logger.info("Demo citgraph cache version mismatch; rebuilding.")
            except Exception as exc:  # corrupt/unreadable cache -> rebuild
                logger.warning(
                    "Failed to load demo citgraph cache, rebuilding: %s", exc
                )
        return self._build_index()

    def _build_index(self) -> _Index:
        logger.info("Building demo citgraph index from %s …", CSV_PATH)
        df = pd.read_csv(
            CSV_PATH,
            dtype=str,
            keep_default_na=False,
            usecols=[
                "id",
                "references",
                "title",
                "abstract",
                "authors",
                "venue",
                "year",
                "n_citation",
                "predicted_main_archetype",
                "predicted_second_tier_archetype",
            ],
        )

        forward: dict[str, list[str]] = {}
        reverse: dict[str, list[str]] = {}
        meta: dict[str, dict] = {}
        title_to_id: dict[str, str] = {}

        for row in df.itertuples(index=False):
            pid = row.id
            refs = _UUID_RE.findall(row.references) if row.references else []
            if refs:
                forward[pid] = refs
                for ref in refs:
                    reverse.setdefault(ref, []).append(pid)
            meta[pid] = {
                "title": row.title,
                "abstract": row.abstract,
                "authors": row.authors,
                "venue": row.venue,
                "year": row.year,
                "n_citation": row.n_citation,
                "predicted_main_archetype": getattr(row, "predicted_main_archetype", None),
                "predicted_second_tier_archetype": getattr(row, "predicted_second_tier_archetype", None),
            }
            tl = row.title.strip().lower()
            # Keep the first occurrence so resolution is deterministic.
            if tl and tl not in title_to_id:
                title_to_id[tl] = pid

        index = _Index(forward, reverse, meta, title_to_id)
        try:
            with open(CACHE_PATH, "wb") as fh:
                pickle.dump(
                    {
                        "version": _CACHE_VERSION,
                        "forward": forward,
                        "reverse": reverse,
                        "meta": meta,
                        "title_to_id": title_to_id,
                    },
                    fh,
                    protocol=5,
                )
            logger.info("Cached demo citgraph index to %s", CACHE_PATH)
        except Exception as exc:  # caching is best-effort
            logger.warning("Could not write demo citgraph cache: %s", exc)
        return index

    def _resolve(self, index: _Index, seed: str) -> str | None:
        """Resolve a seed (UUID or free-text title) to a dataset paper id."""
        seed = seed.strip()
        if not seed:
            return None
        if seed in index.meta:
            return seed
        lowered = seed.lower()
        exact = index.title_to_id.get(lowered)
        if exact is not None:
            return exact
        # Substring fallback: pick the most-cited paper whose title contains the
        # query. Titles are short, so a single scan is acceptable for the demo.
        best_id: str | None = None
        best_citations = -1
        for pid, m in index.meta.items():
            if lowered in m["title"].lower():
                citations = _to_int(m["n_citation"]) or 0
                if citations > best_citations:
                    best_citations = citations
                    best_id = pid
        return best_id

    def _node(self, index: _Index, pid: str, hop: int) -> CitGraphNode:
        m = index.meta[pid]
        main_arch = m.get("predicted_main_archetype")
        if not main_arch or main_arch == "None" or main_arch.strip() == "":
            main_arch = None
        else:
            main_arch = main_arch.strip()

        second_arch = m.get("predicted_second_tier_archetype")
        if not second_arch or second_arch == "None" or second_arch.strip() == "":
            second_arch = None
        else:
            second_arch = second_arch.strip()

        return CitGraphNode(
            paper_id=pid,
            title=m["title"],
            abstract=m.get("abstract") or None,
            year=_to_int(m["year"]),
            citation_count=_to_int(m["n_citation"]),
            reference_count=len(index.forward.get(pid, [])),
            authors=_parse_authors(m["authors"]),
            journal=m["venue"] or None,
            fields_of_study=[],
            hop=hop,
            predicted_main_archetype=main_arch,
            predicted_second_tier_archetype=second_arch,
        )

    async def build(
        self, seed: str, k: int = 1, max_per_hop: int = 20
    ) -> CitGraphResult:
        index = await self._ensure_loaded()

        seed_id = self._resolve(index, seed)
        if seed_id is None or seed_id not in index.meta:
            return CitGraphResult(nodes=[], edges=[], seed_id=seed)

        visited: dict[str, CitGraphNode] = {seed_id: self._node(index, seed_id, 0)}
        edges: list[CitGraphEdge] = []
        edge_set: set[tuple[str, str]] = set()
        frontier: list[str] = [seed_id]

        for hop in range(1, k + 1):
            next_frontier: list[str] = []
            for pid in frontier:
                refs = index.forward.get(pid, [])[:max_per_hop]
                cits = index.reverse.get(pid, [])[:max_per_hop]

                # References: pid cites neighbour -> edge pid -> neighbour.
                # Citations: neighbour cites pid -> edge neighbour -> pid.
                for neighbour, edge in (
                    [(r, (pid, r)) for r in refs]
                    + [(c, (c, pid)) for c in cits]
                ):
                    if neighbour not in index.meta:
                        continue
                    if edge not in edge_set:
                        edge_set.add(edge)
                        edges.append(CitGraphEdge(source=edge[0], target=edge[1]))
                    if neighbour not in visited:
                        visited[neighbour] = self._node(index, neighbour, hop)
                        next_frontier.append(neighbour)
            frontier = next_frontier

        return CitGraphResult(
            nodes=list(visited.values()), edges=edges, seed_id=seed_id
        )
