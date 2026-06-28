# ok-graph 'all' mode multi-hop — 03: tests

## Goal
Unit-test the pure `contractMultiHopEdges` helper (subtask 02) so the multi-hop
contraction logic is locked down without needing the Angular component or HTTP.

## File
New: `frontend/src/app/features/okgraph/multi-hop-contract.spec.ts`
(vitest, matching the other `*.spec.ts` in this folder).

## Helpers
Tiny node/edge factories: a node only needs `paper_id` (+ throwaway required
fields) for these tests; build edges as `{source, target}`.

`isRetained` in tests: pass a set of retained ids and return the id itself when
in the set (identity output-id space), else undefined.

## Cases
1. **Direct edge passthrough**: retained A→B (both retained) ⇒ edge A→B.
2. **Single intermediate**: A→i→B, only A,B retained ⇒ edge A→B (i contracted).
3. **Chain of intermediates**: A→i1→i2→B ⇒ edge A→B.
4. **Boundary stop**: A→B→C all retained (A→B, B→C) ⇒ edges A→B and B→C, but
   **not** A→C (traversal stops at retained B, doesn't tunnel through it).
5. **Direction respected**: edges A→i, C→i (both point INTO intermediate i),
   A,C retained ⇒ **no** edge between A and C (no directed path A⇝C).
6. **Fan-out**: A→i, i→B, i→C ⇒ edges A→B and A→C.
7. **De-dup**: two intermediate paths A→i1→B and A→i2→B ⇒ single edge A→B.
8. **No self-loop**: A→i→A ⇒ no edge (source==target dropped).
9. **Edges touching unknown nodes** are ignored (defensive).

## Run
Per memory `running-tests.md`: frontend vitest headless.
```
cd frontend && npx vitest run src/app/features/okgraph/multi-hop-contract.spec.ts
```
Then a broad type-check / build to confirm the component change compiles.
```
