import { Injectable, computed, inject, signal } from '@angular/core';
import { ProjectService } from './project.service';

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

  readonly activeProjectId = signal<number | null>(readStored());

  readonly activeProject = computed(() => {
    const id = this.activeProjectId();
    if (id === null) return null;
    return this.projectService.projects().find(p => p.id === id) ?? null;
  });

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
