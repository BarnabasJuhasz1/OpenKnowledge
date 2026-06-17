# OK-Graph Info: Configuration sub-page

## Goal
Add a sub-page to the OK-Graph info ('i') panel that shows the configuration
settings used to create the current OK-Graph, alongside the existing
summarization stats.

## Approach
Turn the single-view info panel into a two-tab panel:
- **Summary** — the existing summarization stats (clusters, total/avg time, model).
- **Configuration** — the parameters that drove graph creation/summarization.

Configuration to display (all already available in the frontend):
- OK-Score weights (from `ProjectScoringService` via the `scoreWeights` signal):
  Citations `w_c`, Public code `w_code`, Peer reviewed `w_peer`,
  Dataset `w_data`, Repo stars `w_stars`.
- Summarization model (`summaryStats().model`, falls back to "—" before a run).
- Summarization concurrency (`environment.SUMMARY_CONCURRENCY`).
- Top-K papers / cluster (`environment.SUMMARY_TOP_K`).

## Subtasks
1. **Component** (`okgraph.component.ts`)
   - import `environment`.
   - `infoTab = signal<'summary' | 'config'>('summary')` + `setInfoTab()`.
   - `graphConfig` computed returning weight rows + model + concurrency + topK.
   - `closeInfo()` resets the tab back to 'summary'.
2. **Template** (`okgraph.component.html`)
   - Tab switcher in the info panel header.
   - Render summary block when `infoTab() === 'summary'`, config block otherwise.
3. **Styles** (`okgraph.component.scss`)
   - `.graph-settings__tabs` / `__tab` styling reusing existing palette.
4. **Test** — vitest spec asserting `graphConfig()` reflects weights + env values.

## Done when
- Info panel has Summary/Config tabs; Config lists weights + model + concurrency + top-k.
- `ng build` clean; new spec + existing okgraph specs pass.
