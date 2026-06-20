# OK-score threading — Subtask 1: backend citgraph enrichment

## Goal
Make the citation-graph endpoints return, per node, the four enrichment fields the
project ok-score needs (`has_public_code`, `is_peer_reviewed`, `has_dataset`,
`repo_stars`) by joining each node to the **active project's** DB papers. Nodes
not present in the project DB get neutral defaults (False/0) so their ok-score
naturally reduces to the citation term.

## Files
- `backend/app/api/citgraph.py`

## Changes
1. `CitGraphNodeOut`: add
   - `has_public_code: bool | None = None`
   - `is_peer_reviewed: bool | None = None`
   - `has_dataset: bool = False`
   - `repo_stars: int = 0`
2. Add deps/imports (mirror `scoring.py`): `Query`, `Depends`, `select`,
   `AsyncSession`, `get_db` (`..db.database`), `DBPaper` (`..db.orm_models`).
3. New helper:
   ```python
   async def _enrichment_map(nodes, project_id, db) -> dict[str, dict]:
       # project_id None -> {}; else load project's DBPaper rows, index by
       # lower(doi) and lower(arxiv_id), match each node by doi then arxiv,
       # return {node.paper_id: {has_public_code, is_peer_reviewed,
       #                          has_dataset, repo_stars}}.
   ```
4. `_to_response(result, enrich=None)`: read `enrich.get(n.paper_id, {})` and pass
   the four fields (with defaults) into each `CitGraphNodeOut`.
5. `build_graph`, `build_graph_demo`, `explore_graph`, `explore_graph_demo`: add
   `project_id: int | None = Query(default=None)` and `db: AsyncSession =
   Depends(get_db)`, compute `enrich = await _enrichment_map(result.nodes,
   project_id, db)` after archetype classification, pass to `_to_response`.

## Notes / decisions
- `project_id` is **optional** so the live, project-agnostic citgraph build still
  works when no project is active (enrichment simply skipped).
- Match on `doi` then `arxiv_id`, case-insensitive.

## Testing
- `pytest` (research env): existing citgraph endpoint tests still pass; response
  includes the new fields with defaults when no project/match.
