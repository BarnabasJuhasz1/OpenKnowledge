# Subtask: Backend `/api/dashboard/stats` aggregation endpoint

## Goal
Provide a single endpoint the Dashboard tab can call to render a portfolio-level
overview across **all** projects: aggregate KPIs, a per-project comparison
breakdown, and a recent-activity feed. The Dashboard tab is global (not scoped
to one `:projectId`), so this endpoint is intentionally **not** project-scoped.

## Endpoint
`GET /api/dashboard/stats`

### Response shape
```jsonc
{
  "totals": {
    "projects": 3,
    "library_papers": 42,      // DBBookshelfItem count (all projects)
    "saved_searches": 11,      // DBShelfItem count (all projects)
    "retrieved_papers": 380,   // DBPaper count (all projects)
    "searches_run": 27,        // DBRetrievalJob count (all projects)
    "papers_added_this_week": 6 // DBBookshelfItem created in last 7 days
  },
  "projects": [
    {
      "id": 1,
      "name": "LLM compression",
      "color": "#6366f1",
      "library_papers": 18,
      "saved_searches": 4,
      "retrieved_papers": 210,
      "searches_run": 12,
      "created_at": "...",
      "last_activity": "..."   // max(updated_at) across the project's items, falls back to project.updated_at
    }
  ],
  "recent_activity": [
    {
      "kind": "library_add | saved_search | search_run | project_created",
      "project_id": 1,
      "project_name": "LLM compression",
      "project_color": "#6366f1",
      "title": "Attention Is All You Need",  // item-specific label
      "timestamp": "..."
    }
  ]
}
```

## Implementation notes
- New file `backend/app/api/dashboard.py` with `router = APIRouter(prefix="/dashboard", tags=["dashboard"])`.
- Use efficient aggregate queries (`func.count`, `group_by`) rather than loading rows:
  - Totals: one `count` per table; `papers_added_this_week` via `created_at >= now-7d`.
  - Per-project: `group_by(project_id)` counts for bookshelf, shelf, papers, jobs;
    merge in Python keyed by project id so projects with zero items still appear.
- `last_activity`: take the max timestamp seen for the project across bookshelf
  `updated_at`, shelf `last_used_at`, retrieval job `created_at`, and the
  project's own `updated_at`.
- `recent_activity`: union the most recent ~15 rows from bookshelf adds
  (`created_at`, title), shelf items (`created_at`, label/query_text), and
  retrieval jobs (`created_at`, query_text), plus project_created events; sort
  by timestamp desc in Python and cap at 15. Join project name/color from the
  projects table (build an id→project map once).
- Pydantic response models (`DashboardTotals`, `DashboardProjectStat`,
  `DashboardActivityItem`, `DashboardStatsOut`).
- Register router in `app/main.py` (`app.include_router(dashboard_router, prefix="/api")`).

## Done when
- `GET /api/dashboard/stats` returns 200 with the shape above on an empty DB
  (all zeros, empty lists) and with seeded data.
- e2e test passes (see `dashboard-stats-tests.md`).
