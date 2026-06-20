# OK-score threading — Subtask 3: use ok-score across the OK-Graph

## Goal
Replace the citation-only `repScore` with the project `okScore` everywhere the
OK-Graph treats it as the ok-score: cluster representative selection, gold/silver
star tiers, and the cluster-summary top-k.

## Files
- `frontend/src/app/features/okgraph/okgraph.component.ts`
- `frontend/src/app/core/services/cluster-summary.service.ts`

## okgraph.component.ts
1. Inject `ProjectScoringService`.
2. Add `readonly scoreWeights = signal<ScoreWeights>(this.scoring.defaults());`
   and load it from `this.scoring.load(this.projectContext.activeProjectId())`
   in `ngOnInit` (and constructor) so weight changes apply on (re)entry.
3. Add `private okScoreOf(n: CitGraphNode): number { return okScore(n, this.scoreWeights()); }`
4. Replace every `repScore(n)` call (reps, stars, counts, ranges, and
   `citNodeToPaper(node, repScore(node))`) with `this.okScoreOf(n)`. Because
   `okScoreOf` reads the `scoreWeights` signal, the dependent computeds recompute
   when weights change. `paper.ok_score` (set via `citNodeToPaper`) then carries
   the real score, covering the `starFor(p.paper.ok_score)` call sites for free.

## cluster-summary.service.ts
1. Inject `ProjectScoringService` + `ProjectContextService`.
2. At `start()`, capture `this.weights = scoring.load(projectContext.activeProjectId())`.
3. Replace `repScore(nodes[i])` in `representativeTitle` and the `summarizeFinest`
   top-k sort with `okScore(node, this.weights)`.

## Testing
- `ng build` compiles.
- `cluster-summary.service.spec.ts` + `cluster-ops.spec.ts` still pass.
- Manual: with non-neutral weights (e.g. high w_stars), top-k / representatives
  reorder vs. pure citation order for papers that are in the project DB.
