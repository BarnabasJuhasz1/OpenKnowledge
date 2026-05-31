# Subtask 3 — Project Settings page (absorbs the OK-score feature)

Create the project-scoped Project Settings page. Decision: move the **whole OK-score
feature** (Discovery weight sliders + scored-papers table, and the Analysis single-paper
breakdown) into a **single sectioned page** styled like the existing global Settings
page. The standalone OK-score (`relevancy`) tab is removed.

## Files
- `frontend/src/app/features/project-settings/project-settings.component.ts` (new)
  - Standalone component; imports the existing `DiscoveryTabComponent` and
    `AnalysisTabComponent` from `../relevancy/...` and reuses them as-is (no logic
    duplication).
  - Holds `weights = signal<ScoreWeights>(...)` initialised from
    `ProjectScoringService.load(activeProjectId())`.
  - `onWeightsChange(w)` updates the signal and calls `ProjectScoringService.save(...)`.
  - Exposes `activeProject` from `ProjectContextService` for the header label.
- `frontend/src/app/features/project-settings/project-settings.component.html` (new)
  - `.settings`-style wrapper with a header ("Project Settings") and two
    `settings__section` cards:
    1. **OK-score weights** → `<app-discovery-tab [weights] (weightsChange)>`
    2. **Analyze a paper** → `<app-analysis-tab [weights]>`
- `frontend/src/app/features/project-settings/project-settings.component.scss` (new)
  - Port the `.settings` wrapper styles (settings, __inner, __header, __title,
    __subtitle, __section, __section-head, __section-title, __section-desc) from
    `settings.component.scss` (view-encapsulated, so they can't be shared). Add a gap
    between stacked sections.
- `frontend/src/app/features/relevancy/discovery-tab/discovery-tab.component.html`
  - Remove the internal `discovery__heading` / `discovery__subtitle` lines (the page
    section now supplies the heading), avoiding a duplicate title.
- `frontend/src/app/app.routes.ts`
  - Remove the `:projectId/relevancy` child route.
  - Add `:projectId/project-settings` → lazy-loads `ProjectSettingsComponent`.
  - Leave the legacy top-level `{ path: 'relevancy', redirectTo: 'dashboard/projects' }`.

## Leftovers / scope
- `relevancy.component.*` becomes unused (no route, no sidebar entry). Leave the files in
  place for now (out of scope to delete); `discovery-tab` + `analysis-tab` live on as
  children of Project Settings.

## Test / verify
- `ng build` succeeds with no template/DI errors.
- Navigating to a project → Project Settings shows the weight sliders + scored table and
  the single-paper analyzer; changing a slider re-scores and persists (see subtask 2).
- The old OK-score sidebar tab and `/dashboard/<id>/relevancy` route are gone.
