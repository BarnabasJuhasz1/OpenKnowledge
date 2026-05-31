# Subtask 02 — Backend worker manager + classifier service

## Files
`backend/app/services/archetype/__init__.py`
`backend/app/services/archetype/config.py` — `load_config()` reads JSON
(`ARCHETYPE_CONFIG_PATH` or default `config.json`); returns dict or None if
missing. Helpers for absolute path resolution.
`backend/app/services/archetype/worker.py` — `ArchetypeWorker`:
  - `start()`: spawn persistent subprocess via `asyncio.create_subprocess_exec`
    (python_executable, script_path, "serve", "--config", cfg_path) with
    stdin/stdout pipes; read stderr in a background task (log at debug).
  - Wait for the `{"event":"ready"}` line (up to startup_timeout) → set ready.
  - `classify(items: list[dict]) -> dict[str,(primary,second)]`: serialize one
    request through an asyncio.Lock, write a line, read one response line, parse.
    request_timeout guards a hung worker; on timeout/crash mark not-ready and
    attempt a single respawn next call.
  - `aclose()` for shutdown.
  - Module-level singleton `get_worker()`.

## Service: `backend/app/services/archetype/classifier.py`
- `async def classify_papers(papers: list[Paper]) -> None`:
  - If disabled/no config → return.
  - Select papers with a non-empty abstract AND no `predicted_main_archetype`.
  - Build items `[{"id": str(idx), "abstract": ...}]`; call worker.classify;
    assign `predicted_main_archetype` / `predicted_second_tier_archetype` back by idx.
  - Wrap everything in try/except → log warning, never raise.
- `async def classify_citgraph_nodes(nodes) -> None`: same shape for
  `CitGraphNode` dataclasses (mutate attributes).
- Helper `async def preload() -> None`: ensure the worker is started (used at
  app startup, fire-and-forget).

## Startup preload
In `app/main.py` lifespan: after `init_db()`, if `preload_on_startup`, schedule
`asyncio.create_task(archetype.preload())` so the model loads in the background
without blocking startup. On shutdown, `await worker.aclose()`.

## Test
`backend/tests/unit/test_archetype_classifier.py`: monkeypatch `get_worker` with a
fake worker returning canned results; assert `classify_papers` fills only the
abstract-bearing, unclassified papers and tolerates a raising worker.
