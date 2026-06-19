# Citation graph on hosted data — 02: backend builder

## Goal
Replace the public-Semantic-Scholar-API citation-graph builder with one that uses **only** hosted
data: OpenSearch for seed resolution + node metadata (decision: **OpenSearch only**), BigQuery
`citation_edges` / `citation_edges_by_cited` (plan 01) for edges. Remove all `api.semanticscholar.org`
calls and the `api_key` plumbing.

## Pieces

### A. OpenSearch helpers (`opensearch_search.py`, on `OpenSearchEngine`)
- `resolve_corpusids(seeds: list[str]) -> dict[str, int]`
  - Plain integer seed → that corpusid (verified to exist via the hydration step).
  - Whitespace-free non-int (DOI / arXiv / etc.) → one `bool/should` query with `terms` on the
    indexed `doi` and `arxiv_id` keyword fields; map matched `corpusid` back to the seed.
  - Multi-word seed → `match` on `title`, take the top hit's `corpusid`.
  - Returns only seeds that resolved (legacy S2 SHA-hash seeds are not stored locally → silently
    unresolved; acceptable going forward).
- `fetch_nodes_by_corpusid(corpusids: list[int]) -> dict[int, Paper]`
  - Batched `terms` query on `corpusid` (chunked, e.g. 1000/req, so we never hit the 10k window),
    `_source=_SOURCE_FIELDS`, reusing `_hit_to_paper`. **OpenSearch only** — corpusids absent from
    the index are simply not returned (their nodes/edges get dropped by the builder).

### B. BigQuery edge client (`backend/app/services/retrieval/bigquery_citations.py`, new)
Lazy client mirroring `OpenSearchEngine`'s shape (`is_configured`, lazy `_client`, typed errors
`BigQueryCitationsError` / `BigQueryNotConfiguredError`). Reads env:
`BIGQUERY_DATASET_REF`, `BIGQUERY_CITATION_EDGES_TABLE` (default `citation_edges`),
`BIGQUERY_CITATION_EDGES_BY_CITED_TABLE` (default `citation_edges_by_cited`),
`GOOGLE_APPLICATION_CREDENTIALS` (already set).
- `references(corpusids, cap) -> list[tuple[int,int]]` → `(citing, cited)` where `citing IN ids`,
  capped per source via `QUALIFY ROW_NUMBER() OVER (PARTITION BY citingcorpusid ...) <= cap`.
- `citations(corpusids, cap) -> list[tuple[int,int]]` → `(citing, cited)` where `cited IN ids`,
  capped per source by `citedcorpusid`.
- Parameterised (`@ids` ARRAY<INT64>, `@cap` INT64). Synchronous client; callers wrap in
  `anyio.to_thread.run_sync`.

### C. Builder rewrite (`citgraph_builder.py`)
Keep the public dataclasses (`CitGraphNode`, `CitGraphEdge`, `CitGraphResult`) and the function
names/return types so the API layer is unchanged; **drop the `api_key` param** and the httpx code.
Keep a single error type `UpstreamError` (re-purposed: "edge/metadata backend failed") so existing
imports/handling in `api/citgraph.py` keep working (still maps to 503).

- `_paper_to_node(p: Paper, hop: int) -> CitGraphNode` (corpusid string as `paper_id`).
- `async _traverse(seeds, direction, k, max_per_hop, keywords, include_non_matching)`:
  1. `resolve_corpusids(seeds)` → seed corpusids; hydrate seed nodes (hop 0); empty result if none.
  2. For hop 1..k: pull `references` (if direction past/both) and/or `citations` (future/both) for
     the frontier (each `to_thread`), capped at `max_per_hop` per source. Edge convention matches
     today: **source cites target** — refs give `(seed, neighbor)`, cits give `(neighbor, seed)`.
  3. Hydrate the hop's neighbor corpusids from OpenSearch (batch). **Drop neighbors not in the
     index and any edge touching them** (OpenSearch-only). Apply keyword filter when
     `include_non_matching` is false (drop non-matching neighbors + their edges).
  4. Dedup edges; add new nodes; advance frontier.
- `build_citation_graph(paper_id, k, max_per_hop)` → `_traverse([paper_id], 'both', k, max_per_hop,
  [], True)` with `seed_id` = resolved seed corpusid.
- `explore_citation_graph(seeds, direction, include_non_matching, keywords, k, max_per_hop)` →
  `_traverse(...)`.

### D. Endpoint wiring (`api/citgraph.py`)
Drop `api_key = os.getenv("SEMANTIC_SCHOLAR_API_KEY")` and the `api_key=` args from both
`/build` and `/explore`. Everything else (enrichment, archetype classification, response shape,
404-on-empty) stays. Demo endpoints untouched.

## Notes
- Node `paper_id` changes from S2 SHA hash → corpusid string. The graph response stays internally
  consistent (edges reference the same ids). Frontend matching uses `semantic_scholar_id` (= corpusid)
  and the returned `seed_id`; no frontend change in this plan.
- BigQuery traversal queries are small/cheap (cluster-pruned per corpusid); no Storage Read API
  needed (only the std `google-cloud-bigquery` client, present in the `research` env).
```
