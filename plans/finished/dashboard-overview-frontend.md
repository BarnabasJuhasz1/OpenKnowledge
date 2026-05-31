# Subtask: Frontend Dashboard overview UI

## Goal
Replace the empty `dashboard-home` placeholder with a portfolio overview that
gives the user a high-level view of all their projects: aggregate KPIs, a
project comparison section, and a recent-activity feed. Consume the new
`GET /api/dashboard/stats` endpoint.

## Files
- **New** `frontend/src/app/core/services/dashboard.service.ts`
  - `DashboardStats` + nested interfaces mirroring the backend response.
  - `loadStats(): Observable<DashboardStats>` → `GET http://127.0.0.1:8000/api/dashboard/stats`.
- **Rebuild** `frontend/src/app/features/dashboard-home/dashboard-home.component.{ts,html,scss}`

## UI sections (top → bottom)
1. **Header** — "Dashboard" title + subtitle, optional refresh.
2. **KPI cards row** — Aggregate totals: Projects, Library papers, Saved
   searches, Searches run, + a highlighted "Added this week". Each card: icon,
   big number, label. Reuse existing design tokens (`--ok-surface-*`,
   `--ok-radius-*`, gradients).
3. **Project comparison** — Horizontal CSS bar chart comparing projects by
   library size (bars scaled to the max). Each row: color swatch, name, bar,
   value. Below/alongside: small per-project stat chips (saved searches,
   searches run, last activity relative time). Clicking a project navigates to
   `/dashboard/:id/search`.
4. **Recent activity feed** — Timeline list: icon per `kind`, project color dot,
   title, project name, relative timestamp.

## Behaviour
- Loading state (skeleton or spinner), error state (backend down → friendly
  message), and empty state (no projects → CTA linking to `/dashboard/projects`).
- Use Angular signals + standalone component, matching existing feature
  components (see `projects-landing.component.ts`).
- Relative-time helper (`just now`, `3h ago`, `2d ago`) local to the component.
- No new dependencies — bars are pure CSS.

## Done when
- `dashboard/home` renders KPIs, comparison bars, and activity feed from live
  data; empty/loading/error states behave; `ng build` (or `tsc`) passes with no
  errors.
