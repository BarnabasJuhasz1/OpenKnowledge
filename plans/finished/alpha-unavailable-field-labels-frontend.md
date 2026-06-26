# Alpha: label un-backfilled fields "Not available in the Alpha"

## Context
`has_public_code` / `code_url`, `repo_stars`, and `has_dataset` are not backfilled
in the live index, so any control that filters or weights by them does nothing and
any badge silently never renders. For the alpha, every surface that *refers to*
these fields must visibly signal "Not available in the Alpha" (controls disabled).

Backfilled fields (citations, peer-review/publication_type, year, fields-of-study,
open-access) are unchanged.

## Shared label
Reuse one string constant: `Not available in the Alpha`.

## Surfaces & changes

### 1. Results filters — `features/results/filters-sidebar/filters-sidebar.component.{html,ts}`
- "Has code" checkbox: `disabled`, dim it, append a `Not available in the Alpha` note.

### 2. ok-graph filters — `features/okgraph/in-graph-filter-panel/...html`
and `features/okgraph/graph-filters-popup/...html`
- "Has code" toggle in each: `disabled` + note.

### 3. Relevancy discovery sliders — `features/relevancy/discovery-tab/discovery-tab.component.{ts,html}`
- `SliderConfig` gains `alpha?: boolean`; mark `w_code`, `w_data`, `w_stars`.
- Template: when `slider.alpha`, disable the range input and show
  `Not available in the Alpha` in place of the numeric value.

### 4. Paper card — `features/results/paper-card/paper-card.component.html`
- Code/stars badges already render only when data is present, so they stay hidden
  with no data. No label needed (nothing is shown). Leave as-is.

### 5. Library — `features/library/library.component.html`
- Code badge is likewise conditional; stays hidden. Leave as-is.

### 6. Scoring — `computeOkScore` (`core/services/search-state.service.ts`)
- Already defaults `has_code`/`has_data`/`repo_stars` to 0 when absent, so it yields
  `log10(1+citations) + peer`, matching the backend. Add a short comment noting
  the three terms are inert in the alpha; no behavior change.

## Test
`cd frontend && npx vitest run` (or the project's headless vitest) — ensure existing
specs for filters-sidebar / search-state / discovery still pass; the disabled
attribute is additive and shouldn't break them.
