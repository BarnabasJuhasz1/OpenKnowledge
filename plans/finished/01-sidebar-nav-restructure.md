# Subtask 1 — Sidebar navigation restructure

Relocate Documentation, drop the OK-score feature tab, and add a project-specific
Project Settings tab to the dashboard sidebar / top nav.

## Goals
1. Move the **Documentation** link out of the global top nav and into the dashboard
   sidebar, positioned **above** the global **Settings** link (in the bottom-pinned
   `dashboard__settings` nav).
2. Remove the **OK-score** (`relevancy`) entry from the project feature list.
3. Add a **Project Settings** entry as the **last** item in the project feature list
   (it is project-scoped, so it only appears when a project is active).

## Files
- `frontend/src/app/shared/components/top-nav/top-nav.component.html`
  - Remove the `Documentation` `<a>` tab (keep the `Dashboard` tab).
- `frontend/src/app/features/dashboard/dashboard.component.ts`
  - In `features`: delete `{ path: 'relevancy', label: 'OK-score', icon: 'analytics' }`.
  - Append `{ path: 'project-settings', label: 'Project Settings', icon: 'tune' }`.
- `frontend/src/app/features/dashboard/dashboard.component.html`
  - In the `dashboard__settings` nav, add a `Documentation` nav-link (icon
    `description`, `routerLink="/docs"`, collapse-aware `[title]`) **before** the
    Settings link. Reuse existing `dashboard__nav-link` styling — no SCSS changes.

## Notes
- `/docs` stays a standalone full-page route (it has its own internal Guide/Archetypes
  sidebar; embedding it in the shell would double up sidebars). Only the entry point
  moves.

## Test / verify
- `ng build` succeeds.
- Sidebar shows Documentation above Settings; feature list ends with Project Settings
  and no longer shows OK-score; top nav no longer shows Documentation.
