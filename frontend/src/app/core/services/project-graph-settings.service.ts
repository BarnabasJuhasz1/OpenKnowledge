import { Injectable } from '@angular/core';

/**
 * Per-project settings controlling how the OK-Graph builds and clusters the
 * surrounding citation graph when the user presses "Explore".
 */
export interface GraphSettings {
  /** Neighbourhood depth: how many citation hops out from each seed paper. */
  kHops: number;
  /** Max citations taken per paper per hop, or null for no limit (all citations). */
  maxPerHop: number | null;
  /** Louvain resolution. Higher → more, smaller clusters. */
  resolution: number;
}

/**
 * Persists the OK-Graph exploration settings for each project, mirroring
 * {@link ProjectScoringService}: values live under a per-project localStorage key
 * so every project keeps its own independent configuration.
 */
const KEY_PREFIX = 'ok_graph_settings_';

const DEFAULT_SETTINGS: GraphSettings = {
  kHops: 2,
  maxPerHop: null,
  resolution: 0.5,
};

@Injectable({ providedIn: 'root' })
export class ProjectGraphSettingsService {
  /** A fresh copy of the default exploration settings. */
  defaults(): GraphSettings {
    return { ...DEFAULT_SETTINGS };
  }

  /** Load a project's saved settings, falling back to defaults. */
  load(projectId: number | null): GraphSettings {
    if (projectId === null) return this.defaults();
    try {
      const raw = localStorage.getItem(KEY_PREFIX + projectId);
      if (!raw) return this.defaults();
      const parsed = JSON.parse(raw) as Partial<GraphSettings>;
      // Merge over defaults so a missing/renamed key never yields NaN inputs.
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      // Unparseable JSON or localStorage unavailable — use defaults.
      return this.defaults();
    }
  }

  /** Persist a project's settings. No-op when no project is active. */
  save(projectId: number | null, settings: GraphSettings): void {
    if (projectId === null) return;
    try {
      localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(settings));
    } catch {
      // localStorage unavailable (privacy mode / SSR) — changes apply for the session.
    }
  }
}
