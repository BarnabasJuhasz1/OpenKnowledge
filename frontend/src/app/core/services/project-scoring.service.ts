import { Injectable } from '@angular/core';
import { ScoreWeights } from '../models/paper.model';

/**
 * Persists the OK-score weights for each project so the values chosen in a
 * project's Settings page survive reloads. Weights are stored under a
 * per-project localStorage key; every project keeps its own independent set.
 */
const KEY_PREFIX = 'ok_score_weights_';

const DEFAULT_WEIGHTS: ScoreWeights = {
  w_c: 1.0,
  w_code: 1.0,
  w_peer: 1.0,
  w_data: 1.0,
  w_stars: 1.0,
};

@Injectable({ providedIn: 'root' })
export class ProjectScoringService {
  /** A fresh copy of the neutral (all-1.0) weights. */
  defaults(): ScoreWeights {
    return { ...DEFAULT_WEIGHTS };
  }

  /** Load a project's saved weights, falling back to defaults. */
  load(projectId: number | null): ScoreWeights {
    if (projectId === null) return this.defaults();
    try {
      const raw = localStorage.getItem(KEY_PREFIX + projectId);
      if (!raw) return this.defaults();
      const parsed = JSON.parse(raw) as Partial<ScoreWeights>;
      // Merge over defaults so a missing/renamed key never yields NaN sliders.
      return { ...DEFAULT_WEIGHTS, ...parsed };
    } catch {
      // Unparseable JSON or localStorage unavailable — use defaults.
      return this.defaults();
    }
  }

  /** Persist a project's weights. No-op when no project is active. */
  save(projectId: number | null, weights: ScoreWeights): void {
    if (projectId === null) return;
    try {
      localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(weights));
    } catch {
      // localStorage unavailable (privacy mode / SSR) — changes apply for the session.
    }
  }
}
