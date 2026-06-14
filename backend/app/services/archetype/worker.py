"""Persistent subprocess worker that runs the archetype classifier.

The model takes several seconds to load (CUDA init + weights), so we keep a single
long-lived worker process alive and talk to it over stdin/stdout with newline-
delimited JSON. The worker is spawned once (ideally preloaded at app startup) and
reused for every request. All access is serialized through an asyncio lock since a
single pipe pair cannot interleave concurrent request/response cycles.

Every operation is best-effort: if the worker cannot start or a request fails, we
log and return empty results so retrieval is never blocked.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from .config import config_path, load_config

logger = logging.getLogger(__name__)

# asyncio's StreamReader.readline() defaults to a 64 KB buffer; a response line
# carrying many predictions easily exceeds that, so give the pipes plenty of room.
_STREAM_LIMIT = 256 * 1024 * 1024  # 256 MB
# Cap items per worker request so each request/response line stays modest and the
# work is bounded — large result sets are processed across several round-trips.
_DEFAULT_CHUNK = 256


class ArchetypeWorker:
    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._ready = False
        self._req_id = 0
        self._stderr_task: asyncio.Task | None = None

    @property
    def is_ready(self) -> bool:
        return self._ready and self._proc is not None and self._proc.returncode is None

    async def _drain_stderr(self) -> None:
        """Forward the worker's diagnostics to our logs (debug level)."""
        assert self._proc is not None and self._proc.stderr is not None
        try:
            async for raw in self._proc.stderr:
                logger.debug("archetype-worker: %s", raw.decode(errors="replace").rstrip())
        except Exception:  # noqa: BLE001 — stderr pump must never raise
            pass

    async def start(self) -> bool:
        """Spawn the worker and wait until it reports ready. Idempotent."""
        async with self._lock:
            if self.is_ready:
                return True
            await self._spawn_locked()
            return self.is_ready

    async def _spawn_locked(self) -> None:
        self._ready = False
        python = self._cfg.get("python_executable")
        script = self._cfg.get("script_path")

        # Resolve python executable with fallbacks
        import shutil
        import sys
        
        python_resolved = False
        if python:
            if Path(python).exists():
                python_resolved = True
            else:
                shutil_resolved = shutil.which(python)
                if shutil_resolved:
                    python = shutil_resolved
                    python_resolved = True

        if not python_resolved:
            # Fallback check for dependencies in current environment
            has_deps = False
            try:
                import torch
                import transformers
                import safetensors
                has_deps = True
            except ImportError:
                pass
            
            if has_deps:
                logger.info(
                    "Configured archetype python executable not found (%s). "
                    "However, current environment has archetype dependencies installed. Falling back to %s.",
                    python, sys.executable
                )
                python = sys.executable
                python_resolved = True
            else:
                logger.warning("Archetype python executable not found: %s", python)
                return

        if not script or not Path(script).is_file():
            logger.warning("Archetype script not found: %s", script)
            return

        startup_timeout = float(self._cfg.get("startup_timeout_seconds", 180))
        logger.info("Starting archetype worker (%s) …", script)
        try:
            self._proc = await asyncio.create_subprocess_exec(
                python, script, "serve", "--config", str(config_path()),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_STREAM_LIMIT,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to spawn archetype worker: %s", e)
            self._proc = None
            return

        self._stderr_task = asyncio.create_task(self._drain_stderr())

        # Wait for the readiness line.
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=startup_timeout)
        except asyncio.TimeoutError:
            logger.warning("Archetype worker did not become ready within %ss.", startup_timeout)
            await self._terminate_locked()
            return

        if not line:
            logger.warning("Archetype worker exited before becoming ready.")
            await self._terminate_locked()
            return
        try:
            msg = json.loads(line.decode())
        except json.JSONDecodeError:
            logger.warning("Unexpected first line from archetype worker: %r", line)
            await self._terminate_locked()
            return
        if msg.get("event") == "ready":
            self._ready = True
            logger.info("Archetype worker ready.")
        else:
            logger.warning("Archetype worker sent %r instead of ready.", msg)
            await self._terminate_locked()

    async def _terminate_locked(self) -> None:
        self._ready = False
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    self._proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        self._proc = None

    async def classify(self, items: list[dict]) -> dict[str, dict]:
        """Classify items, returning ``{item_id: result_dict}``.

        ``items`` is ``[{"id": str, "abstract": str}, ...]``. Large lists are split
        into chunks so each request/response line stays modest. Returns whatever
        was classified before any failure (empty dict if the worker is unavailable).
        """
        if not items:
            return {}

        chunk_size = int(self._cfg.get("request_chunk_size", _DEFAULT_CHUNK))
        merged: dict[str, dict] = {}

        async with self._lock:
            if not self.is_ready:
                await self._spawn_locked()
            if not self.is_ready:
                return merged

            for start in range(0, len(items), chunk_size):
                chunk = items[start : start + chunk_size]
                result = await self._request_locked(chunk)
                if result is None:
                    # Worker died mid-run — return what we have so far.
                    break
                merged.update(result)
        return merged

    async def _request_locked(self, items: list[dict]) -> dict[str, dict] | None:
        """Send one request and parse the response. Caller must hold the lock.

        Returns the parsed ``{id: result}`` map, or ``None`` if the worker failed
        (in which case it has been torn down for a fresh respawn next time).
        """
        assert self._proc is not None and self._proc.stdin and self._proc.stdout
        self._req_id += 1
        request = {"id": self._req_id, "items": items}
        timeout = float(self._cfg.get("request_timeout_seconds", 120))
        try:
            self._proc.stdin.write((json.dumps(request) + "\n").encode())
            await self._proc.stdin.drain()
            line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=timeout)
        except (asyncio.TimeoutError, ConnectionError, BrokenPipeError) as e:
            logger.warning("Archetype request failed (%s); resetting worker.", e)
            await self._terminate_locked()
            return None
        except Exception as e:  # noqa: BLE001
            logger.warning("Archetype request error: %s", e)
            await self._terminate_locked()
            return None

        if not line:
            logger.warning("Archetype worker closed the pipe mid-request.")
            await self._terminate_locked()
            return None

        try:
            response = json.loads(line.decode())
        except json.JSONDecodeError:
            logger.warning("Malformed archetype response (len=%d)", len(line))
            return {}

        results = response.get("results") or []
        return {str(r.get("id")): r for r in results if r.get("id") is not None}

    async def aclose(self) -> None:
        async with self._lock:
            await self._terminate_locked()
        if self._stderr_task:
            self._stderr_task.cancel()


_worker: ArchetypeWorker | None = None


def get_worker() -> ArchetypeWorker | None:
    """Return the process-wide worker, or ``None`` if the feature is disabled."""
    global _worker
    if _worker is not None:
        return _worker
    cfg = load_config()
    if cfg is None:
        return None
    _worker = ArchetypeWorker(cfg)
    return _worker


async def shutdown_worker() -> None:
    global _worker
    if _worker is not None:
        await _worker.aclose()
        _worker = None
