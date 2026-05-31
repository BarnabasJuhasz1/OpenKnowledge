# Real-time Archetype Classification for Retrieved Papers

## Goal
Whenever papers are retrieved through any real flow — the live search stream,
its background continuation, and the clustering-tab citation graph — automatically
infer each paper's archetype (primary + secondary) from its abstract using the
fine-tuned `MultiTaskClassifier` (SciBERT-based) checkpoint. Stop relying on the
pre-computed archetypes in the demo CSV; classify every paper in real time.

## Key facts discovered
- Checkpoint: `archetype_classifier/models/fast_archetype_model/checkpoint-6402/`.
  It has **no `config.json`** and SciBERT is not downloaded locally, BUT the full
  encoder weights live in `model.safetensors` (203 tensors: `encoder.*`,
  `primary_classifier.*`, `secondary_classifier.*`). So the encoder architecture
  can be rebuilt from a static BERT config dict and the weights loaded offline —
  no network, no SciBERT download. Verified: `missing:0 unexpected:0`, sensible
  predictions.
- Labels: `fast_archetype_model/label_mapping.json` → 9 primary, 22 secondary.
- The backend venv has **no** torch/transformers. We must NOT bloat it.
- A dedicated conda env (`okarchetype`) with torch+transformers+safetensors runs
  the model (GPU: RTX 4060, CUDA available).
- `Paper` (pydantic) and the frontend models already carry
  `predicted_main_archetype` / `predicted_second_tier_archetype`. The DB
  (`DBPaper`) does NOT — must be added.
- Live results use the SSE stream (`/retrieval/search/stream`); clustering uses
  `/citgraph/build`. Real (non-demo) responses currently produce no archetypes.

## Architecture
- **Separate standalone script** (`classify_retrieved_papers.py`) that runs in the
  dedicated conda env. Two modes:
  - `serve`: persistent worker — load model once, then read newline-delimited
    JSON requests on stdin, write JSON responses on stdout (logs to stderr only).
  - `batch`: one-shot `--input`/`--output` JSON for CLI/testing.
- **Backend worker manager** spawns the persistent worker at app startup and
  **preloads the model in the background** so the first search does not block.
  Communicates over stdin/stdout pipes, serialized by an asyncio lock. Best-effort:
  any failure leaves archetypes unset and never breaks retrieval.
- **Single JSON config file** controls everything (checkpoint, env python, batch
  size, device, enable flag), overridable via `ARCHETYPE_CONFIG_PATH`.

## Subtasks
1. `01-standalone-script-and-config.md` — the script + config file + new conda env.
2. `02-backend-worker-and-service.md` — worker manager, classifier service, startup preload.
3. `03-integration-and-persistence.md` — wire into retrieval/background/citgraph/demo, DB columns.
4. `04-frontend-archetype-patch.md` — stream archetype patch event + state patching.

## Testing
- Script: batch-mode smoke test on sample abstracts in the new env.
- Backend: unit test for the classifier service against a stub worker; existing
  backend test suite must still pass.
- Frontend: production build must succeed.
