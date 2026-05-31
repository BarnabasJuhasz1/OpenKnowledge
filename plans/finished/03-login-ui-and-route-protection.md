# Subtask 03 — Frontend: Log In/Out UI + protect routes

## Goal
Top-right Log In button (right of the GitHub "Contribute" button) opening a
provider chooser; becomes Log Out + user chip when authenticated. Remove the
Dashboard tab. Guard all feature routes.

## Steps
1. **Login modal** — `frontend/src/app/features/auth/login-modal.component.ts`
   (standalone). Overlay with title and one button per **configured** provider
   (`auth.providers()`), each with its brand SVG (Google, Microsoft, Apple,
   GitHub). Clicking calls `auth.login(provider)`. `[open]` input + `(close)`
   output; closes on backdrop click / Esc.
2. **Top-nav** — `top-nav.component.html` / `.ts`
   - **Remove** the `Dashboard` tab block (the `top-nav__tabs` nav).
   - In `top-nav__actions`, **after** the Contribute button:
     - When logged out: a `Log In` button → opens the modal.
     - When logged in: a user chip (avatar/name) + a `Log Out` button →
       `auth.logout()`.
   - Render `<app-login-modal>` bound to a local `loginOpen` signal.
   - Auto-open the modal when the URL carries `?login=required` (guard redirect).
3. **Routes** — `app.routes.ts`: add `canActivate: [authGuard]` and
   `canActivateChild: [authGuardChild]` to the top-level `dashboard` route so the
   shell **and** every child (`home`, `projects`, `settings`, `:projectId/*`) are
   protected. Landing (`''`) and `docs` stay public.
4. **Post-login redirect** lands on `/dashboard` (from backend callback); the
   guard now passes because the session cookie is set.

## Verify
- Logged out: visiting `/dashboard`, `/dashboard/projects`,
  `/dashboard/<id>/graph/ok`, etc. all redirect to `/` and the login modal opens.
- `Log In` shows only configured providers; clicking routes to the backend
  authorize endpoint.
- After a successful provider sign-in the user lands on the dashboard and the
  button reads `Log Out`; logging out returns to the landing page and re-locks
  the features.

## Done when
`npm run build` passes and the manual matrix above holds (verified against a
running backend with at least one provider configured, or with provider buttons
present when unconfigured).
