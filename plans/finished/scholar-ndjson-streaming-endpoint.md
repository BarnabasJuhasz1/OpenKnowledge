# Scholar search: NDJSON streaming endpoint off iter_search

## Goal
Let Semantic Scholar mode return result sets too large to buffer (unbounded
`OPENSEARCH_RESULT_LIMIT`) by streaming papers as NDJSON instead of one `SearchResponse`.

## Design
- **Additive, non-breaking:** new route `POST /retrieval/scholar/search/stream`
  (`application/x-ndjson`). The existing buffered `POST /search` is unchanged, so the SPA
  keeps working until its service is migrated.
- **Protocol** — one JSON object per line:
  - `{"type":"paper","paper":{...}}` per result (BM25 order for a finite limit; `_doc`
    order, possibly millions, when unbounded).
  - `{"type":"summary","total_found":N, ...}` terminal line (same metadata fields as
    `SearchResponse` minus `papers`).
  - `{"type":"error","detail":"..."}` terminal line if the scroll fails mid-stream (HTTP is
    already 200 by then, so failures are reported in-band; papers gathered before the
    failure are flushed first).
- **Backpressure / memory:** papers are pulled from the blocking `engine.iter_search`
  generator in `_STREAM_BATCH` (500) chunks via `anyio.to_thread.run_sync` (keeps the event
  loop free), classified per batch with `archetype.classify_papers`, then emitted. Memory
  stays bounded no matter how many million match.
- **Fail-fast:** empty request -> 422, unconfigured engine -> 503, invalid boolean query ->
  422, all *before* the 200 stream is committed (`compile_to_opensearch` is validated up
  front).

## Tests (`tests/unit/test_scholar_endpoint.py`)
Papers-then-summary ordering; raw boolean passthrough; 422 (empty), 503 (unconfigured),
422 (bad boolean); mid-stream error emits already-collected papers then an `error` line.
`_FakeEngine` gained `iter_search` + `is_configured`.

## Verified live (tunnel to the GCP node)
`200 application/x-ndjson`; real papers stream and the client can stop early (proves it is
not buffered); completing stream ends with the `summary` line (`total_found` correct).

## Follow-up (not done here)
Frontend still calls the buffered `/search` via `RetrievalService.scholarSearch`. To consume
the stream, add a `scholarSearchStream` mirroring the existing `searchStream` reader but
parsing bare NDJSON lines (no `data:` prefix) and the `type` discriminator.
