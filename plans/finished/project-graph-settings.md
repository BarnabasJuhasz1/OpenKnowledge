# Subtask: Project-scoped OK-Graph exploration settings

## What
Persist per-project graph-exploration parameters, mirroring how
`ProjectScoringService` persists OK-score weights (per-project localStorage key).

## Settings
```ts
interface GraphSettings {
  kHops: number;            // neighbourhood depth, default 2
  maxPerHop: number | null; // null = no limit (all citations), default null
  resolution: number;       // Louvain resolution, default 0.5
}
```

## Files
- NEW `frontend/src/app/core/services/project-graph-settings.service.ts`
  - `GraphSettings` interface, `DEFAULTS = { kHops: 2, maxPerHop: null, resolution: 0.5 }`
  - `KEY_PREFIX = 'ok_graph_settings_'`
  - `defaults()`, `load(projectId)`, `save(projectId, settings)` — same shape/guards
    as `ProjectScoringService`.
- EDIT `frontend/src/app/features/project-settings/project-settings.component.ts`
  - add `FormsModule` to imports, inject the new service + `ProjectContextService`,
    expose a `graphSettings` signal + `updateGraphSetting(partial)` that saves.
- EDIT `frontend/src/app/features/project-settings/project-settings.component.html`
  - add an "OK-Graph exploration" section with number inputs for the three fields
    (blank max-per-hop = no limit).

## Test
Type-checks in `npm run build`; values persist across reloads (localStorage).
