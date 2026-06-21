"""HTTP transport for the archetype classifier (Cloud Run service).

Drop-in replacement for the local subprocess ``ArchetypeWorker``: exposes the same
``classify(items) -> {id: result}`` contract, but instead of spawning a torch
process it POSTs batches to a remote FastAPI classifier (see ``archetype_server``).
This is the default path once ``ARCHETYPE_CLASSIFIER_URL`` is configured, so the
deployed backend needs no torch.

Every operation is best-effort: on any network/HTTP error we log and return
whatever was classified so far (empty dict if nothing), so retrieval is never
blocked by the classifier being cold, slow, or down.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

# Cap items per request so each round-trip stays modest; large sets span several.
_DEFAULT_CHUNK = 256


class HttpArchetypeWorker:
    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._base_url = str(cfg["classifier_url"]).rstrip("/")
        self._api_key = cfg.get("classifier_api_key") or ""
        self._timeout = float(cfg.get("request_timeout_seconds", 120))
        self._chunk = int(cfg.get("request_chunk_size", _DEFAULT_CHUNK))
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()
        self._ready = False

    @property
    def is_ready(self) -> bool:
        return self._ready

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                headers=self._headers(),
            )
        return self._client

    async def start(self) -> bool:
        """Warm the remote service with a health ping (wakes Cloud Run from zero)."""
        async with self._lock:
            client = await self._get_client()
            startup_timeout = float(self._cfg.get("startup_timeout_seconds", 180))
            try:
                resp = await client.get("/health", timeout=startup_timeout)
                self._ready = resp.status_code == 200
            except Exception as e:  # noqa: BLE001 — best-effort warmup
                logger.info("Archetype classifier health ping failed (will retry on demand): %s", e)
                self._ready = False
            return self._ready

    async def classify(self, items: list[dict]) -> dict[str, dict]:
        """Classify ``[{"id", "abstract"}]`` → ``{id: result}``; never raises."""
        if not items:
            return {}

        client = await self._get_client()
        merged: dict[str, dict] = {}
        for start in range(0, len(items), self._chunk):
            chunk = items[start : start + self._chunk]
            try:
                resp = await client.post("/classify", json={"items": chunk})
                resp.raise_for_status()
                payload = resp.json()
            except Exception as e:  # noqa: BLE001 — return partial results
                logger.warning("Archetype classify request failed (%s); returning partial.", e)
                break
            self._ready = True
            for r in payload.get("results") or []:
                rid = r.get("id")
                if rid is not None:
                    merged[str(rid)] = r
        return merged

    async def aclose(self) -> None:
        async with self._lock:
            if self._client is not None:
                try:
                    await self._client.aclose()
                except Exception:  # noqa: BLE001
                    pass
                self._client = None
            self._ready = False
