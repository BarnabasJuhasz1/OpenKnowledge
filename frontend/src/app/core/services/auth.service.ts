import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

/** A user authenticated through a 3rd-party OAuth provider. */
export interface AuthUser {
  id: number;
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

/** Provider id → display label. Only configured providers reach the UI. */
export const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
  github: 'GitHub',
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  // Auth calls go through relative /api so the dev proxy keeps them same-origin
  // with the SPA — that makes the session cookie first-party.
  private readonly baseUrl = '/api/auth';

  private readonly _user = signal<AuthUser | null>(null);
  private readonly _providers = signal<string[]>([]);
  private readonly _ready = signal(false);

  /** The signed-in user, or null. */
  readonly user = this._user.asReadonly();
  /** Provider ids the backend has credentials for (e.g. ['google','github']). */
  readonly providers = this._providers.asReadonly();
  /** True once the initial session probe has resolved. */
  readonly ready = this._ready.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  /**
   * Probe the backend for an existing session and the list of usable providers.
   * Called once at app startup (via an app initializer) so route guards have a
   * definitive answer before the first navigation resolves.
   */
  async loadSession(): Promise<void> {
    try {
      const user = await firstValueFrom(
        this.http.get<AuthUser>(`${this.baseUrl}/me`, { withCredentials: true })
      );
      this._user.set(user);
    } catch {
      this._user.set(null); // 401 — not signed in
    }

    try {
      const res = await firstValueFrom(
        this.http.get<{ providers: string[] }>(`${this.baseUrl}/providers`, {
          withCredentials: true,
        })
      );
      this._providers.set(res.providers ?? []);
    } catch {
      this._providers.set([]);
    }

    this._ready.set(true);
  }

  /** Begin the OAuth redirect flow for a provider (full-page navigation). */
  login(provider: string): void {
    window.location.href = `${this.baseUrl}/login/${provider}`;
  }

  /** Clear the server session and return to the public landing page. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(`${this.baseUrl}/logout`, null, { withCredentials: true })
      );
    } finally {
      this._user.set(null);
      this.router.navigateByUrl('/');
    }
  }
}
