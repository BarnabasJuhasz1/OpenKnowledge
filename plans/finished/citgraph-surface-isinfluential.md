# Citation graph — surface `isinfluential` through the edge provider

## Problem
The S2 "highly influential citation" flag is a **boolean per edge** (`isinfluential`). It is
already present and populated in the BigQuery edge tables `citation_edges` /
`citation_edges_by_cited` (schema `... isinfluential BOOLEAN`), but the edge provider's SQL only
`SELECT citingcorpusid, citedcorpusid`, so the flag never reaches the graph. We want it exposed
end-to-end (edge provider -> builder -> API JSON) at ~zero extra query cost (column already in the
clustered tables).

Note: this is distinct from `influentialcitationcount` (integer per *paper*, already in OpenSearch)
and from `intents` (categorical per edge: background/methodology/result — **not** in the queryable
tables; see separate plan).

## Subtasks

### 1. Edge provider returns triples (`bigquery_citations.py`)
- `_run` SQL: add `isinfluential` to the SELECT list (QUALIFY/cluster pruning unchanged).
- Return `(citing, cited, isinfluential)` triples; `bool(r["isinfluential"])` so a NULL maps to
  `False` (treat unknown as not-influential).
- Update return type hints on `_run` / `references` / `citations` to `list[tuple[int, int, bool]]`
  and the module docstring note.

### 2. Builder carries the flag (`citgraph_builder.py`)
- `CitGraphEdge`: add `is_influential: bool = False`.
- `_traverse`: unpack triples from `edge_results`; extend the `tagged` item shape to
  `(anchor, neighbour, (citing, cited), is_influential)`; thread the flag through the candidate /
  usable / cap loops; set `CitGraphEdge(..., is_influential=infl)` when appending.
- Dedup stays keyed on `(citing, cited)`; first occurrence wins (same row in both tables ⇒ same
  flag, so consistent).

### 3. API exposes it (`api/citgraph.py`)
- `CitGraphEdgeOut`: add `is_influential: bool = False`.
- `_to_response`: pass `is_influential=e.is_influential`.

### 4. Demo builder (`demo_citgraph.py`)
- No influential data in the demo fixture → leave edges at the `is_influential=False` default
  (no change needed beyond the dataclass default).

### 5. Tests
- `test_bigquery_citations.py`: rows include `isinfluential`; assert `"isinfluential"` in SQL and
  triple outputs (e.g. `[(100, 200, False)]`); add a case where the flag is `True`.
- `test_citgraph_builder.py`: `_FakeBQ` normalizes stored 2-/3-tuples to triples; add a test that a
  `True` flag propagates to `CitGraphEdge.is_influential` / the API.

## Verify
- `pytest tests/unit/test_bigquery_citations.py tests/unit/test_citgraph_builder.py tests/unit/test_demo_citgraph.py`
  in the `research` conda env.
- Optional live spot-check: a seeded build returns at least one edge with `is_influential=True`
  for a paper known to have influential citers.

## Done when
Backend tests pass and the citgraph API JSON includes `is_influential` per edge.
