import { Injectable, computed, signal } from '@angular/core';

/**
 * Retrieval mode.
 *
 * Only `'scholar'` is in active use — it is the default and the only mode reachable
 * from the UI (there is no mode-selector component). `'live'` and `'demo'` are
 * **DEPRECATED**: kept for reference / possible future revival, but unselectable and
 * unsupported. Do not build new features against them.
 *
 * @see SEARCH_MODE_OPTIONS
 */
export type SearchMode = 'scholar' | /** @deprecated unselectable, unsupported */ 'live' | /** @deprecated unselectable, unsupported */ 'demo';

const STORAGE_KEY = 'ok_search_mode';
const LEGACY_DEMO_KEY = 'ok_demo_mode';
const DEFAULT_MODE: SearchMode = 'scholar';

export interface SearchModeOption {
  id: SearchMode;
  label: string;
  hint: string;
}

/**
 * Selectable retrieval modes. Currently scholar-only: there is no mode-selector UI,
 * so this list is effectively reference data. The `'live'` and `'demo'` options are
 * intentionally omitted — those modes are deprecated and must not be offered to users.
 */
export const SEARCH_MODE_OPTIONS: SearchModeOption[] = [
  { id: 'scholar', label: 'Semantic Scholar', hint: 'Boolean search over the Semantic Scholar corpus' },
  // DEPRECATED — do not re-add to the UI:
  //   { id: 'live', label: 'Live APIs', hint: 'Query OpenAlex, arXiv, PubMed and more in real time' },
  //   { id: 'demo', label: 'Demo', hint: 'Bundled sample dataset — no network required' },
];

/**
 * Tracks which retrieval mode the user wants. Replaces the old binary demo toggle.
 * Semantic Scholar (the BigQuery-backed corpus search) is the default.
 */
@Injectable({ providedIn: 'root' })
export class SearchModeService {
  readonly mode = signal<SearchMode>(this.loadInitial());

  readonly isScholar = computed(() => this.mode() === 'scholar');
  /** @deprecated Live mode is unselectable/unsupported; always false in practice. */
  readonly isLive = computed(() => this.mode() === 'live');
  /** @deprecated Demo mode is unselectable/unsupported; always false in practice. */
  readonly isDemo = computed(() => this.mode() === 'demo');

  setMode(next: SearchMode): void {
    this.mode.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch { /* storage unavailable */ }
  }

  private loadInitial(): SearchMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'scholar' || stored === 'live' || stored === 'demo') {
        return stored;
      }
      // Back-compat: a user who previously had demo mode ON keeps demo.
      const legacy = localStorage.getItem(LEGACY_DEMO_KEY);
      if (legacy !== null && JSON.parse(legacy) === true) {
        return 'demo';
      }
    } catch { /* storage unavailable */ }
    return DEFAULT_MODE;
  }
}
