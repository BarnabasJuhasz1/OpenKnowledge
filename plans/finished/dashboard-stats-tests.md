# Subtask: Backend e2e test for `/api/dashboard/stats`

## Goal
Verify the dashboard stats endpoint aggregates correctly across projects.

## File
`backend/tests/e2e/test_dashboard_endpoint.py` (follow the style of
`test_projects_endpoint.py` — `httpx.AsyncClient` + `ASGITransport`, async test).

## Cases
1. **Shape on (near) empty** — `GET /api/dashboard/stats` returns 200 with
   `totals`, `projects`, `recent_activity` keys; totals are ints.
2. **Aggregation** — Create a project, add 2 bookshelf items and 1 shelf item
   (project-scoped via `params={"project_id": pid}`), then GET stats and assert:
   - the project appears in `projects` with `library_papers == 2`,
     `saved_searches == 1`;
   - global `totals.library_papers` increased by ≥ 2;
   - `recent_activity` contains an entry for this project (by `project_id`).
   Use a `uuid`-suffixed project name and unique identifiers so the test is
   order-independent against the shared session DB.

## Run
```
cd backend && python -m pytest tests/e2e/test_dashboard_endpoint.py -q
```

## Done when the new test passes (and existing e2e tests still pass).
