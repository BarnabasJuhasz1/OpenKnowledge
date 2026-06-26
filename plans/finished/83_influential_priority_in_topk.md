# 83 — Prioritise influential citations within the per-paper top-K

## Goal
In the **general** OK-Graph build (i.e. when `INFLUENTIAL_CITATIONS_ONLY` is **off**, so
non-influential edges are still kept), the per-paper top-K selection should treat S2
"highly influential" citations as higher priority than non-influential ones.

Concretely, for each anchor paper's candidate neighbours:
1. Partition into two subsets — influential (`isinfluential = TRUE`) and non-influential.
2. Sort each subset by ok-score (proxied by `citation_count`, descending).
3. Concatenate (influential subset first) and keep the top-K.

So an influential neighbour is always kept ahead of a non-influential one, and ties within
a subset fall back to the existing ok-score ordering. `top_k_per_paper` (the admin per-hop
cap) is unchanged in meaning — only the *ordering* used to pick the K changes.

This is a no-op when `influential_only=True` (non-influential edges are already dropped) and
when `top_k_per_paper` is `None` (everything is kept regardless of order).

## Subtasks

### 1. Per-paper top-K sort (`citgraph_builder.py::_traverse`)
The per-paper cap block currently sorts each anchor group by `_cite_count(t[1])` only.
Change the sort key to `(is_influential, _cite_count(neighbour))` with `reverse=True`, where
`is_influential` is `t[3]`. A descending tuple sort puts `True` before `False` (the
partition), then orders each partition by citation count. Stable sort keeps fetch order on
exact ties → deterministic. Update the explanatory comment.

### 2. BigQuery pushdown ordering (`bigquery_citations.py::_run`)
When the per-paper top-K cap is pushed down to BigQuery, the `QUALIFY ROW_NUMBER()` window
currently ranks each source's edges by `neighbor_citationcount DESC` and over-fetches
`cap * overfetch`. A low-citation *influential* neighbour could fall outside that buffer and
never reach the Python sort, silently defeating the new priority. Add `isinfluential DESC`
as the leading `ORDER BY` term so influential edges are always in the buffer first. The
column is already selected, so this adds no scan cost. Update the comment.

### 3. Tests (`tests/unit/test_citgraph_builder.py`)
- `test_top_k_prioritises_influential_over_higher_cited`: an influential, low-citation citer
  is kept over a non-influential, higher-citation citer when top-K would otherwise drop it.
- `test_top_k_influential_then_ok_score_within_partition`: within each partition, ordering is
  still by citation count (influential high-cite before influential low-cite; the kept
  non-influential one is the highest-cited non-influential).
- Confirm existing `test_top_k_per_paper_keeps_highest_cited_citers` still passes (all edges
  non-influential there, so ok-score ordering is unaffected).

## Verification
- `pytest tests/unit/test_citgraph_builder.py` (research env) green.
- Adjacent suites (`test_demo_citgraph.py`, `test_citgraph_enrichment.py`,
  `test_bigquery_citations.py`) green.
