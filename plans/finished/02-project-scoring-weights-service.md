# Subtask 2 — Per-project scoring weights persistence

Introduce a small shared service that persists OK-score weights per project, so the
weights set in Project Settings survive reloads (decision: "persist per project").

## Files
- `frontend/src/app/core/services/project-scoring.service.ts` (new)
  - `defaults(): ScoreWeights` → all weights `1.0`.
  - `load(projectId: number | null): ScoreWeights` → read
    `localStorage['ok_score_weights_<id>']`, merged over defaults; falls back to
    defaults when missing/unparseable or when `projectId` is null.
  - `save(projectId: number | null, weights: ScoreWeights): void` → write JSON;
    no-op when `projectId` is null. All `localStorage` access wrapped in try/catch
    (privacy mode / SSR safe), matching `ProjectContextService`.

## Test / verify
- `ng build` succeeds.
- Adjusting weights in Project Settings then reloading restores them for that project;
  a different project keeps its own independent values.
