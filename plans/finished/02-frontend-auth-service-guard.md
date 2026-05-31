# Subtask 02 — Frontend: auth service, route guard, dev proxy

## Goal
Expose backend auth state to the Angular SPA, gate every feature behind login,
and make the session cookie work in dev.

## Steps
1. **Dev proxy** — so auth cookies are same-origin:
   - Add `frontend/proxy.conf.json`:
     `{ "/api": { "target": "http://127.0.0.1:8000", "secure": false,
       "changeOrigin": false } }`
   - `package.json` `start` → `ng serve --port 4201 --proxy-config proxy.conf.json`.
   - `angular.json` serve options → add `"proxyConfig": "proxy.conf.json"`.
   - Auth calls use **relative** `/api/auth/...` URLs (other existing services keep
     their absolute `127.0.0.1:8000` URLs — only auth needs the cookie).
2. **AuthService** — `frontend/src/app/core/services/auth.service.ts`
   - Signals: `user = signal<AuthUser | null>(null)`,
     `providers = signal<string[]>([])`, `ready = signal(false)`.
   - `isAuthenticated = computed(() => user() !== null)`.
   - `loadSession(): Promise<void>` → GET `/api/auth/me` (withCredentials),
     sets user (null on 401), then GET `/api/auth/providers`, sets `ready`.
   - `login(provider)` → `window.location.href = '/api/auth/login/' + provider`.
   - `logout()` → POST `/api/auth/logout` (withCredentials) then clear user and
     navigate to `/`.
3. **App initializer** — `app.config.ts`: `provideAppInitializer(() =>
   inject(AuthService).loadSession())` so guards have auth state before routing.
4. **Guard** — `frontend/src/app/core/guards/auth.guard.ts` (`CanActivateFn` +
   `CanActivateChildFn`): if `auth.isAuthenticated()` return true; else return a
   `UrlTree` to `/` with `queryParams: { login: 'required' }`.

## Done when
`npm run build` succeeds; unauthenticated `/api/auth/me` resolves to `user=null`
and the initializer does not crash bootstrap.
