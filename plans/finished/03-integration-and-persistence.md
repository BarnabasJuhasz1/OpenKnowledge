# Subtask 03 — Wire into retrieval/citgraph/demo + DB persistence

## Persistence (DBPaper)
- Add columns `predicted_main_archetype` / `predicted_second_tier_archetype`
  (`String`, nullable) to `DBPaper` in `orm_models.py`.
- Add them to `_apply_migrations` in `db/database.py` (ALTER TABLE for existing
  SQLite DBs, guarded by column presence check on the `papers` table).
- In `persistence._upsert_paper`, `_set_if_empty` both fields.

## retrieval.py
- `/search`: `await archetype.classify_papers(response.papers)` before
  `flush_all`/`upsert_papers`/return.
- `/search/stream`: after the `async for` over sources completes and `all_papers`
  is collected, `await archetype.classify_papers(all_papers)` BEFORE persisting.
  Then emit a new SSE event before the `done` event:
  `event: archetypes` / `data: {"archetypes": {<paperKey>: [primary, second]}}`
  where `paperKey` mirrors the frontend `paperId()` priority
  (doi || arxiv_id || semantic_scholar_id || openalex_id || title).
- `/background/{job_id}`: when the job completes, `await classify_papers(job.papers)`
  before emitting the `papers` event so background-fetched papers are classified too.

## citgraph.py
- `/build` (real): after `build_citation_graph`, `await classify_citgraph_nodes(result.nodes)`.
- `_to_response`: include `predicted_main_archetype` / `predicted_second_tier_archetype`
  on each `CitGraphNodeOut` (was previously dropped). Add the two fields to
  `CitGraphNodeOut`.
- `/demo/build`: also classify nodes (demo graph nodes carry abstracts) so demo
  graphs get real-time archetypes instead of the CSV's.

## demo.py (stop trusting CSV archetypes)
- In `DemoDataStore._row_to_paper`, stop populating archetypes from the CSV (leave
  them None); demo search responses get classified by the demo endpoint.
- `demo.py` API `/retrieval/demo/search`: `await classify_papers(papers)` before return.
- `demo_citgraph.py`: nodes already expose abstracts; classification happens at the
  citgraph `/demo/build` endpoint, so no archetype reads from CSV needed there.

## Test
- Existing backend suite still green (`pytest`), especially `test_demo.py`,
  `test_demo_citgraph.py`, `test_citgraph_builder.py` — update any assertions that
  expected CSV archetypes.
