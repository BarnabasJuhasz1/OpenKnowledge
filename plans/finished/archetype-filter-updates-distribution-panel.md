# Archetype filter should update the distribution panel accordingly

## Problem
The Archetypes distribution panel shows the full archetype distribution of the
match set and does NOT react to the archetype filter. Today's design treats the
distribution as "archetype-agnostic" (see `results.component.ts` effect comment):
toggling archetypes reloads the result page server-side but leaves the panel
unchanged. The user wants the panel to reflect the current archetype selection.

## Approach
Make the `archetypeDistribution` computed in `filters-sidebar.component.ts`
respect `state.selectedArchetypes()`:
- Only count archetypes that are currently selected.
- Recompute each segment's percentage over the selected-subset total, so the
  panel shows the distribution *within the filtered view*.
- Deselected archetypes fall to count 0 / 0% and render greyed via the existing
  `archetype-list__item--empty` styling; bar segments already only draw when
  `percentage > 0`, so excluded archetypes vanish from the bar automatically.

This is purely client-side and reacts instantly to checkbox toggles — no backend
change and no classify-stream restart needed. The full streamed counts
(`scholarArchetypeCounts`) remain the source of truth; we just project the
selected subset out of them. Works identically in demo/live mode (which counts
loaded scored papers).

## Subtasks
1. Filter `archetypeDistribution` by `selectedArchetypes` (Scholar + demo paths);
   recompute `totalClassified` over the selected subset only.
2. Update the now-inaccurate effect comment in `results.component.ts` (the panel
   DOES reflect the selection now, client-side; the classify stream still isn't
   restarted because the underlying match-set counts are unchanged).
3. Tests: a filters-sidebar spec asserting the distribution reflects the
   selection (deselected archetype → 0%, remaining recomputed).

## Test
- `npx ng test --no-watch`
