"""High-level archetype classification used by the retrieval & citgraph APIs.

Every function is best-effort and never raises: if the classifier is disabled,
not yet loaded, or errors out, papers simply keep their existing (usually empty)
archetype fields and the surrounding request proceeds normally.
"""

from __future__ import annotations

import logging
from typing import Any

from .worker import get_worker

logger = logging.getLogger(__name__)


def _needs_classification(obj: Any) -> bool:
    """A paper/node needs classification if it has an abstract but no primary archetype."""
    abstract = getattr(obj, "abstract", None)
    if not abstract or not str(abstract).strip():
        return False
    return not getattr(obj, "predicted_main_archetype", None)


async def _classify(objects: list[Any]) -> None:
    """Classify any objects (Paper or CitGraphNode) lacking an archetype, in place."""
    worker = get_worker()
    if worker is None:
        return

    targets = [obj for obj in objects if _needs_classification(obj)]
    if not targets:
        return

    items = [{"id": str(i), "abstract": getattr(obj, "abstract")} for i, obj in enumerate(targets)]
    try:
        results = await worker.classify(items)
    except Exception as e:  # noqa: BLE001 — defensive; worker already guards internally
        logger.warning("Archetype classification failed: %s", e)
        return

    for i, obj in enumerate(targets):
        result = results.get(str(i))
        if not result:
            continue
        primary = result.get("primary")
        secondary = result.get("secondary")
        if primary:
            obj.predicted_main_archetype = primary
        if secondary:
            obj.predicted_second_tier_archetype = secondary


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
