# OK-score threading — Subtask 2: frontend model + ok-score function

## Goal
Carry the new enrichment fields onto `CitGraphNode`, let the project_id query
param reach the citgraph endpoints, and add a pure `okScore(node, weights)`
mirroring the backend scorer formula.

## Files
- `frontend/src/app/core/services/citgraph.service.ts` — extend `CitGraphNode`.
- `frontend/src/app/core/interceptors/project.interceptor.ts` — stop exempting
  `/api/citgraph` so the active `project_id` is attached (backend treats it as
  optional, so demo/no-project still works).
- `frontend/src/app/features/okgraph/cit-node.ts` — add `okScore`.

## Changes
1. `CitGraphNode` interface: add
   `has_public_code?: boolean | null; is_peer_reviewed?: boolean | null;
    has_dataset?: boolean; repo_stars?: number;`
   (HttpClient casts JSON directly, so no manual mapping is needed.)
2. `project.interceptor.ts`: remove `/api/citgraph` from `isExempt`.
3. `cit-node.ts`:
   ```ts
   import { ScoreWeights } from '../../core/models/paper.model';
   export function okScore(n: CitGraphNode, w: ScoreWeights): number {
     const cit = n.citation_count || 0;
     const stars = n.repo_stars || 0;
     const code = n.has_public_code ? 1 : 0;
     const peer = n.is_peer_reviewed ? 1 : 0;
     const data = n.has_dataset ? 1 : 0;
     const score = w.w_c * Math.log10(1 + cit)
       + w.w_code * code + w.w_peer * peer + w.w_data * data
       + w.w_stars * Math.log10(1 + stars);
     return +score.toFixed(2);
   }
   ```
   Keep `repScore` as the citation-only fallback (still the default ok_score when
   no weights are available).

## Testing
- New `cit-node.spec.ts`: `okScore` matches the backend formula for a few cases
  (neutral weights == repScore when no enrichment; enrichment terms add up;
  weights scale terms).
- `ng build` compiles.
