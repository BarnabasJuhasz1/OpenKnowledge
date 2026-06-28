import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { Project, ProjectService } from './project.service';

/**
 * Holds the currently active project id. It is the single source of truth that
 * the HTTP interceptor and feature views read so every API call is scoped to
 * the project the user is working in. The id is driven by the `:projectId`
 * route segment (set by the dashboard shell).
 */
const STORAGE_KEY = 'ok_active_project';

@Injectable({ providedIn: 'root' })
export class ProjectContextService {
  private readonly projectService = inject(ProjectService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly activeProjectId = signal<number | null>(readStored());

  readonly activeProject = computed(() => {
    const id = this.activeProjectId();
    if (id === null) return null;
    return this.projectService.projects().find(p => p.id === id) ?? null;
  });

  constructor() {
    // The backend scopes /api/projects to the session, so the project list must
    // follow the signed-in identity. Reload whenever auth resolves or flips
    // (login/logout), then drop a now-inaccessible active project.
    effect(() => {
      const ready = this.auth.ready();
      this.auth.user(); // track identity so login/logout re-runs this effect
      if (!ready) return;
      this.reloadForCurrentUser();
    });
  }

  private reloadForCurrentUser(): void {
    this.projectService.load().subscribe({
      next: list => this.dropActiveIfInaccessible(list),
      error: () => {},
    });
  }

  /** If the active project isn't in the (reloaded) list, clear it and, when the
   *  user is sitting inside it, bounce back to the project picker. */
  private dropActiveIfInaccessible(list: Project[]): void {
    const id = this.activeProjectId();
    if (id === null || list.some(p => p.id === id)) return;
    this.setActiveProject(null);
    if (this.router.url.includes(`/dashboard/${id}`)) {
      this.router.navigateByUrl('/dashboard/projects');
    }
  }

  /**
   * Set the active project. Persisted so the sidebar keeps showing it (and its
   * feature sub-tabs) while the user is on the Dashboard or My Projects pages.
   */
  setActiveProject(id: number | null): void {
    this.activeProjectId.set(id);
    try {
      if (id === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      // localStorage unavailable (e.g. SSR / privacy mode) — ignore.
    }
  }
}

function readStored(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}
