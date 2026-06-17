import { Injectable, computed, signal } from '@angular/core';

export type SearchMode = 'scholar' | 'live' | 'demo';

const STORAGE_KEY = 'ok_search_mode';
const LEGACY_DEMO_KEY = 'ok_demo_mode';
const DEFAULT_MODE: SearchMode = 'scholar';

export interface SearchModeOption {
  id: SearchMode;
  label: string;
  hint: string;
}

export const SEARCH_MODE_OPTIONS: SearchModeOption[] = [
  { id: 'scholar', label: 'Semantic Scholar', hint: 'Boolean search over the Semantic Scholar corpus' },
  { id: 'live', label: 'Live APIs', hint: 'Query OpenAlex, arXiv, PubMed and more in real time' },
  { id: 'demo', label: 'Demo', hint: 'Bundled sample dataset — no network required' },
];

/**
 * Tracks which retrieval mode the user wants. Replaces the old binary demo toggle.
 * Semantic Scholar (the BigQuery-backed corpus search) is the default.
 */
@Injectable({ providedIn: 'root' })
export class SearchModeService {
  readonly mode = signal<SearchMode>(this.loadInitial());

  readonly isScholar = computed(() => this.mode() === 'scholar');
  readonly isLive = computed(() => this.mode() === 'live');
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
