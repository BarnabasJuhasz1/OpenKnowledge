"""Resumable-ingestion primitives: corpusid bands, a durable checkpoint, and retry/backoff.

Pure stdlib, no BigQuery/OpenSearch imports, so it is trivially unit-testable. Used by
``ingest_opensearch.py`` to make the load survive crashes without redoing completed work.

Why bands? The BigQuery Storage Read API streams are *unordered*, so the only reliable
resume unit is a server-side corpusid range: a band ``[lo, hi)`` is "done" once every
corpusid in that range is indexed, regardless of the order streams happened to arrive in.
Interrupted bands are reprocessed (idempotent ``_id = corpusid``); done bands are skipped.

This file is kept byte-identical between ``backend/scripts/`` (dev) and
``deploy/opensearch-ingest/scripts/`` (the standalone bundle shipped to the VM).
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass

logger = logging.getLogger("ingest")


@dataclass(frozen=True)
class Band:
    """A half-open corpusid range ``[lo, hi)`` with its sequential index."""

    index: int
    lo: int
    hi: int


def compute_bands(corpusid_max: int, band_width: int) -> list[Band]:
    """Partition ``[0, corpusid_max]`` into fixed-width half-open bands.

    Band ``i`` covers ``[i*band_width, (i+1)*band_width)``; the final band's ``hi`` is
    ``corpusid_max + 1`` so the maximum corpusid is included. Returns ``[]`` when there is
    nothing to cover (``corpusid_max < 0``).
    """
    if band_width <= 0:
        raise ValueError(f"band_width must be positive, got {band_width}")
    if corpusid_max < 0:
        return []
    bands: list[Band] = []
    lo = 0
    index = 0
    while lo <= corpusid_max:
        hi = lo + band_width
        if hi > corpusid_max + 1:
            hi = corpusid_max + 1
        bands.append(Band(index=index, lo=lo, hi=hi))
        lo += band_width
        index += 1
    return bands


class Checkpoint:
    """Durable record of which band indices are fully indexed.

    Saves atomically (temp file + ``os.replace``) so a crash mid-write can never corrupt the
    resume state. A checkpoint is only honoured when its stored ``band_width`` and
    ``corpusid_max`` match the current run — otherwise band indices would mean different ranges,
    so the stale file is ignored and a fresh checkpoint is started.
    """

    def __init__(self, path: str, band_width: int, corpusid_max: int,
                 completed: set[int] | None = None) -> None:
        self.path = path
        self.band_width = band_width
        self.corpusid_max = corpusid_max
        self._completed: set[int] = set(completed or set())

    @classmethod
    def load_or_init(cls, path: str, band_width: int, corpusid_max: int) -> "Checkpoint":
        if os.path.exists(path):
            try:
                data = json.loads(open(path, encoding="utf-8").read())
            except (OSError, ValueError) as exc:
                logger.warning("checkpoint %s unreadable (%s); starting fresh", path, exc)
                return cls(path, band_width, corpusid_max)
            if (data.get("band_width") == band_width
                    and data.get("corpusid_max") == corpusid_max):
                completed = {int(b) for b in data.get("completed_bands", [])}
                logger.info("resuming from checkpoint %s: %d band(s) already done",
                            path, len(completed))
                return cls(path, band_width, corpusid_max, completed)
            logger.warning(
                "checkpoint %s params changed (band_width %s->%s, corpusid_max %s->%s); "
                "ignoring stale file and starting fresh",
                path, data.get("band_width"), band_width,
                data.get("corpusid_max"), corpusid_max,
            )
        return cls(path, band_width, corpusid_max)

    def is_done(self, band_index: int) -> bool:
        return band_index in self._completed

    @property
    def completed_count(self) -> int:
        return len(self._completed)

    def remaining(self, bands: list[Band]) -> list[Band]:
        return [b for b in bands if b.index not in self._completed]

    def mark_done(self, band_index: int) -> None:
        self._completed.add(band_index)
        self._save()

    def _save(self) -> None:
        body = {
            "band_width": self.band_width,
            "corpusid_max": self.corpusid_max,
            "completed_bands": sorted(self._completed),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(body, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)


def with_retries(fn, *, attempts: int, base_delay: float, max_delay: float,
                 exceptions: tuple[type[BaseException], ...], sleep=time.sleep,
                 on_retry=None):
    """Call ``fn()``; retry on ``exceptions`` with exponential backoff, then re-raise.

    Backoff before retry ``n`` (1-indexed) is ``min(max_delay, base_delay * 2**(n-1))``.
    ``sleep`` and ``on_retry(attempt, exc, delay)`` are injectable so tests run without
    real delays. ``attempts`` is the total number of tries (>= 1).
    """
    if attempts < 1:
        raise ValueError(f"attempts must be >= 1, got {attempts}")
    last_exc: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except exceptions as exc:  # type: ignore[misc]
            last_exc = exc
            if attempt >= attempts:
                break
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            else:
                logger.warning("attempt %d/%d failed (%s); retrying in %.1fs",
                               attempt, attempts, exc, delay)
            sleep(delay)
    assert last_exc is not None
    raise last_exc
