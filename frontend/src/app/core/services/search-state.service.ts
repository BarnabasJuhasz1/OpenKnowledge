import { Injectable, computed, signal } from '@angular/core';
import { Paper } from '../models/paper.model';
import { deduplicatePapers } from '../../shared/utils/dedup-papers';

/**
 * Holds search state at the application level so it survives route changes
 * (e.g. navigating to /relevancy and back to /results).
 */
@Injectable({ providedIn: 'root' })
export class SearchStateService {
  /** Raw papers stored per source — the exact results each API returned. */
  readonly rawPapersBySource = signal<Record<string, Paper[]>>({});

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sourcesQueried = signal<string[]>([]);
  readonly sourcesFailed = signal<string[]>([]);
  readonly currentPage = signal(1);
  readonly rawQuery = signal('');
  readonly activeFilter = signal<string | null>(null);
  readonly queriesUsed = signal<Record<string, string>>({});
  readonly sourceErrors = signal<Record<string, string>>({});
  readonly sourcesCompleted = signal<string[]>([]);

  /** Relevancy scores keyed by paper title (lowercase). */
  readonly scoresByTitle = signal<Record<string, number>>({});
  readonly scoresLoading = signal(false);

  /** Total raw paper count across all sources (before dedup). */
  readonly totalRaw = computed(() => {
    const bySource = this.rawPapersBySource();
    return Object.values(bySource).reduce((sum, papers) => sum + papers.length, 0);
  });

  /** All raw papers concatenated (for dedup). */
  private readonly allRawPapers = computed(() => {
    const bySource = this.rawPapersBySource();
    const all: Paper[] = [];
    for (const papers of Object.values(bySource)) {
      all.push(...papers);
    }
    return all;
  });

  /** Deduplicated papers for the "All" view. */
  private readonly dedupResult = computed(() => deduplicatePapers(this.allRawPapers()));

  readonly deduplicatesRemoved = computed(() => this.dedupResult().duplicatesRemoved);

  /** Papers shown to the user — depends on active filter. Scores are attached. */
  readonly filteredPapers = computed(() => {
    const filter = this.activeFilter();
    let papers: Paper[];
    if (!filter) {
      papers = this.dedupResult().papers;
    } else {
      papers = this.rawPapersBySource()[filter] ?? [];
    }
    // Attach relevancy scores
    const scores = this.scoresByTitle();
    return papers.map(p => {
      const key = p.title.toLowerCase();
      const score = scores[key];
      if (score !== undefined && p.relevancy_score !== score) {
        return { ...p, relevancy_score: score };
      }
      return p;
    });
  });

  readonly totalFound = computed(() => this.filteredPapers().length);

  readonly activeQuery = computed(() => {
    const filter = this.activeFilter();
    if (!filter) return null;
    return this.queriesUsed()[filter] ?? null;
  });

  readonly activeError = computed(() => {
    const filter = this.activeFilter();
    if (!filter) return null;
    return this.sourceErrors()[filter] ?? null;
  });

  /** Whether state has been populated (to distinguish "no results" from "never searched"). */
  readonly hasSearched = computed(() => this.rawQuery() !== '');

  /** Reset all state for a new search. */
  resetForNewSearch(): void {
    this.loading.set(true);
    this.error.set(null);
    this.activeFilter.set(null);
    this.rawPapersBySource.set({});
    this.sourcesQueried.set([]);
    this.sourcesFailed.set([]);
    this.sourcesCompleted.set([]);
    this.queriesUsed.set({});
    this.sourceErrors.set({});
    this.scoresByTitle.set({});
    this.scoresLoading.set(false);
  }
}
