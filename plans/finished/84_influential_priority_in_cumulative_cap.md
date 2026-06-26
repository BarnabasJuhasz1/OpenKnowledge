# 84 — Align the cumulative per-hop cap ranking with the per-paper top-K

## Goal
The cumulative per-hop cap (`max_per_hop_total`) currently keeps the globally highest
**ok-score** (citation_count proxy) new papers each hop. Plan 83 made the per-paper top-K
prioritise influential citations first; this plan makes the cumulative cap rank the **same
way** — influential-tier papers first, then by ok-score — so the two caps are consistent.

## Definition
The per-paper top-K ranks *edges* (each has an `is_influential` flag). The cumulative cap
ranks *distinct new papers*, and a paper may be reached by several edges this hop. A new
paper is treated as **influential-tier if any of its incoming edges this hop is
influential**. Ranking is then `(influential_tier, citation_count)` descending — identical
ordering semantics to the per-paper top-K.

## Subtask
`citgraph_builder.py::_traverse`, cumulative cap block:
- Track per new neighbour whether *any* of its edges this hop is influential (OR-accumulate),
  instead of only its citation count.
- Sort the new-paper set by `(any_influential, _cite_count(cid))` descending and keep the
  first `max_per_hop_total`. Stable sort keeps deterministic order on exact ties.
- Update the comment to say the kept set is influential-first then ok-score.

No-op when `influential_only=True` (non-influential edges already gone) and when every edge
is non-influential (ranking collapses to pure ok-score — existing behaviour).

## Tests (`tests/unit/test_citgraph_builder.py`)
- `test_cumulative_cap_prioritises_influential`: a low-citation influential new paper is kept
  over a higher-citation non-influential one when the cumulative cap would otherwise drop it.
- Existing `test_explore_max_per_hop_cumulative` (all non-influential) must still pass.

## Verification
- `pytest tests/unit/test_citgraph_builder.py tests/unit/test_bigquery_citations.py` green.
