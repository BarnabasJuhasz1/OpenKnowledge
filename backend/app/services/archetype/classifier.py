"""High-level archetype classification used by the retrieval & citgraph APIs.

Every function is best-effort and never raises: if the classifier is disabled,
not yet loaded, or errors out, papers simply keep their existing (usually empty)
archetype fields and the surrounding request proceeds normally.
"""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Awaitable, Callable

from . import cache
from .worker import get_worker

logger = logging.getLogger(__name__)


def _apply(obj: Any, primary: str | None, secondary: str | None) -> None:
    """Set archetype fields on a paper/node, leaving missing values untouched."""
    if primary:
        obj.predicted_main_archetype = primary
    if secondary:
        obj.predicted_second_tier_archetype = secondary


def _needs_classification(obj: Any) -> bool:
    """A paper/node needs classification if it has classifiable text but no primary archetype.

    Classifiable text is the abstract when present, else the title — abstracts are
    licensing-limited (~19% coverage), so abstract-less papers are classified from their
    title instead of falling into the "Unknown" bucket.
    """
    abstract = getattr(obj, "abstract", None)
    title = getattr(obj, "title", None)
    has_text = bool((abstract and str(abstract).strip()) or (title and str(title).strip()))
    if not has_text:
        return False
    return not getattr(obj, "predicted_main_archetype", None)


async def _classify(objects: list[Any]) -> None:
    """Classify any objects (Paper or CitGraphNode) lacking an archetype, in place.

    Results are cached by paper identity (see :mod:`.cache`): a paper already classified in
    an earlier call — e.g. before a Scholar filter narrowed the set — is filled from the
    cache and never re-sent to the remote model.
    """
    # Serve from cache first; this works even when the worker is disabled.
    targets: list[Any] = []
    for obj in objects:
        if not _needs_classification(obj):
            continue
        cached = cache.get(cache.paper_cache_key(obj))
        if cached is not None:
            _apply(obj, cached[0], cached[1])
            continue
        targets.append(obj)

    worker = get_worker()
    if not targets or worker is None:
        return

    # Send both fields; the classifier uses the abstract when present, else the title.
    items = [
        {
            "id": str(i),
            "abstract": getattr(obj, "abstract", None),
            "title": getattr(obj, "title", None),
        }
        for i, obj in enumerate(targets)
    ]
    try:
        results = await worker.classify(items)
    except Exception as e:  # noqa: BLE001 — defensive; worker already guards internally
        logger.warning("Archetype classification failed: %s", e)
        return

    for i, obj in enumerate(targets):
        result = results.get(str(i))
        if not result:
            # No result this round — leave uncached so it retries on the next call.
            continue
        primary = result.get("primary")
        secondary = result.get("secondary")
        _apply(obj, primary, secondary)
        cache.put(cache.paper_cache_key(obj), primary, secondary)


async def classify_papers(papers: list[Any]) -> None:
    """Fill archetypes on retrieved ``Paper`` objects that lack them."""
    await _classify(papers)


async def classify_citgraph_nodes(nodes: list[Any]) -> None:
    """Fill archetypes on citation-graph nodes that lack them."""
    await _classify(nodes)


async def preload() -> None:
    """Start the worker so the model is loaded before the first request.

    Intended to be scheduled as a background task at app startup. Best-effort.
    """
    worker = get_worker()
    if worker is None:
        return
    try:
        ok = await worker.start()
        if ok:
            logger.info("Archetype classifier preloaded.")
        else:
            logger.info("Archetype classifier preload did not complete; will retry on demand.")
    except Exception as e:  # noqa: BLE001
        logger.warning("Archetype preload error: %s", e)


def compute_ok_score(obj: Any) -> float:
    """Compute the OK score for a Paper or CitGraphNode using default weights.

    Used to prioritize which papers get classified first — highest score first —
    so the most relevant results populate the archetype distribution soonest.
    """
    citations = float(getattr(obj, "citation_count", 0) or 0)
    has_code = float(bool(getattr(obj, "has_public_code", False)))
    is_peer = float(bool(getattr(obj, "is_peer_reviewed", False)))
    has_data = float(bool(getattr(obj, "has_dataset", False)))
    stars = float(getattr(obj, "repo_stars", 0) or 0)

    score = (
        math.log10(1.0 + citations)
        + has_code
        + is_peer
        + has_data
        + math.log10(1.0 + stars)
    )
    return round(score, 2)


class BatchClassifier:
    """Queue that runs archetype classification on papers in batches.

    Processing is ordered by ok_score descending. New arrivals are dynamically
    merged and re-prioritized, so whatever is currently the highest-scoring
    unclassified paper is always taken next. Optionally capped via
    ``max_to_classify``. Every batch is best-effort and never raises.
    """

    def __init__(
        self,
        batch_size: int = 50,
        classified_callback: Callable[[list[Any]], Awaitable[None]] | None = None,
        max_to_classify: int | None = None,
    ) -> None:
        self.batch_size = batch_size
        self.classified_callback = classified_callback
        self.max_to_classify = max_to_classify
        self._total_classified = 0
        self._queue: list[Any] = []
        self._lock = asyncio.Lock()
        self._event = asyncio.Event()
        self._fetching_complete = False
        self._task: asyncio.Task | None = None

    async def add_papers(self, papers: list[Any]) -> None:
        """Add new papers/nodes to the queue (only those needing classification)."""
        to_add = [p for p in papers if _needs_classification(p)]
        if not to_add:
            return
        async with self._lock:
            self._queue.extend(to_add)
            self._event.set()

    def mark_fetching_complete(self) -> None:
        """Signal that no more papers will be added."""
        self._fetching_complete = True
        self._event.set()

    def start(self) -> None:
        """Start the background processing task."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._process_loop())

    async def stop(self) -> None:
        """Signal fetching is complete and wait for the remaining queue to drain."""
        self.mark_fetching_complete()
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _process_loop(self) -> None:
        while True:
            async with self._lock:
                if self.max_to_classify is not None and self._total_classified >= self.max_to_classify:
                    self._queue.clear()
                    self._fetching_complete = True

                has_items = len(self._queue) > 0
                is_done = self._fetching_complete and not has_items

            if is_done:
                break

            if not has_items:
                self._event.clear()
                await self._event.wait()
                continue

            async with self._lock:
                if not self._queue:
                    continue
                # Sort the queue by ok_score descending in-place — highest first.
                self._queue.sort(key=compute_ok_score, reverse=True)

                size = self.batch_size
                if self.max_to_classify is not None:
                    remaining = self.max_to_classify - self._total_classified
                    if remaining <= 0:
                        self._queue.clear()
                        continue
                    size = min(size, remaining)

                batch = self._queue[:size]
                self._queue = self._queue[size:]
                self._total_classified += len(batch)

            if batch:
                try:
                    await classify_papers(batch)
                    if self.classified_callback:
                        await self.classified_callback(batch)
                except Exception as e:  # noqa: BLE001 — one bad batch must not kill the loop
                    logger.warning("Batch classification failed: %s", e)
                finally:
                    self._event.clear()
