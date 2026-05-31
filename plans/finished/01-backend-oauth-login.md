# Subtask 01 — Backend: 3rd-party OAuth login + session

## Goal
Add real OAuth2 (authorization-code) login to the FastAPI backend for **Google,
Microsoft, Apple, and GitHub**, with a server-side signed-cookie session. This
is the only authentication mechanism.

## Why these choices
- **Authlib** is the de-facto OAuth client for Starlette/FastAPI and handles the
  authorize-redirect + token-exchange + (for OIDC providers) ID-token parsing.
- **Starlette `SessionMiddleware`** (signed cookie via `itsdangerous`) stores the
  logged-in user id. No extra session store needed for a single-node app.
- Providers are registered **only if their client id/secret are configured**, so
  the app boots with zero credentials and the frontend just shows fewer buttons.

## Steps
1. **Deps** — add to `backend/requirements.txt`:
   - `authlib>=1.3.0`
   - `itsdangerous>=2.0.0`
2. **User model** — `backend/app/db/orm_models.py`: add `DBUser`
   - `id` (pk), `provider` (str), `provider_account_id` (str),
     `email` (nullable str), `name` (nullable str), `avatar_url` (nullable str),
     `created_at`, `last_login_at`.
   - `UniqueConstraint(provider, provider_account_id)`.
   - `create_all` in `init_db()` creates the table automatically (new table, no
     migration needed).
3. **Auth config** — `backend/app/auth/config.py`
   - Read env: `SESSION_SECRET`, `FRONTEND_URL` (default `http://localhost:4201`),
     `OAUTH_REDIRECT_BASE_URL` (default = `FRONTEND_URL`).
   - Per provider read `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`
     (GOOGLE_, MICROSOFT_, APPLE_, GITHUB_).
   - Build an Authlib `OAuth` registry; register each provider that has both id &
     secret. Google/Microsoft use OIDC discovery; GitHub uses its OAuth + user API;
     Apple uses OIDC (client secret may be a pre-generated JWT supplied via
     `APPLE_CLIENT_SECRET`).
   - `configured_providers() -> list[str]` returns the registered names.
   - Helper `normalize_userinfo(provider, token, userinfo)` → `{provider_account_id,
     email, name, avatar_url}`.
4. **Auth router** — `backend/app/api/auth.py` (`prefix="/auth"`)
   - `GET /providers` → `{ providers: [...] }` (configured provider list).
   - `GET /login/{provider}` → `authorize_redirect` to the provider. Redirect URI =
     `{OAUTH_REDIRECT_BASE_URL}/api/auth/callback/{provider}`. 404 if provider not
     configured.
   - `GET /callback/{provider}` → exchange code, fetch/parse userinfo, upsert
     `DBUser`, store `user_id` in `request.session`, then **redirect to
     `{FRONTEND_URL}/dashboard`**. On failure redirect to `{FRONTEND_URL}/?login=error`.
   - `GET /me` → current user (`UserOut`) or `401` if no session.
   - `POST /logout` → `request.session.clear()`, `204`.
   - `current_user` dependency reads `request.session["user_id"]` and loads the user.
5. **Wire app** — `backend/app/main.py`
   - `app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET,
     same_site="lax", https_only=False)`.
   - `app.include_router(auth_router, prefix="/api")`.
6. **Docs** — add `backend/.env.example` documenting all the new env vars.

## Dev cookie strategy (important)
The Angular dev server proxies `/api` → backend (see subtask 02), so the browser
sees auth endpoints as **same-origin** with the SPA (`localhost:4201`). That makes
the session cookie first-party and `SameSite=Lax` sufficient — no HTTPS/`SameSite=None`
needed in dev. The OAuth `redirect_uri` therefore points at the **frontend** proxy
path, not directly at `:8000`.

## Tests (`backend/tests/e2e/test_auth_endpoint.py`)
- `GET /api/auth/me` with no session → 401.
- `POST /api/auth/logout` → 204.
- `GET /api/auth/providers` → 200 with a list (possibly empty when unconfigured).
- `GET /api/auth/login/{unknown}` → 404.
- A configured-provider login redirect (monkeypatch a fake provider into the
  registry) → 302 to the provider authorize URL.

## Done when
`pytest backend/tests` passes and the server boots with no OAuth env configured.
