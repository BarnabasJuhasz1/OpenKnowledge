import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { RetrievalService } from '../../core/services/retrieval.service';
import { Paper } from '../../core/models/paper.model';
import { parseQuery } from '../../shared/utils/query-parser';
import { deduplicatePapers } from '../../shared/utils/dedup-papers';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';
import { ResultsMetaComponent } from './results-meta/results-meta.component';
import { PaperListComponent } from './paper-list/paper-list.component';
import { PaginationComponent } from './pagination/pagination.component';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-results',
  standalone: true,
  imports: [
    RouterLink,
    QueryInputComponent,
    ResultsMetaComponent,
    PaperListComponent,
    PaginationComponent,
  ],
  templateUrl: './results.component.html',
  styleUrl: './results.component.scss',
})
export class ResultsComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly retrieval = inject(RetrievalService);
  private streamSub: Subscription | null = null;

  /** Raw papers stored per source — the exact results each API returned. */
  rawPapersBySource = signal<Record<string, Paper[]>>({});

  loading = signal(false);
  error = signal<string | null>(null);
  sourcesQueried = signal<string[]>([]);
  sourcesFailed = signal<string[]>([]);
  currentPage = signal(1);
  rawQuery = signal('');
  activeFilter = signal<string | null>(null);
  queriesUsed = signal<Record<string, string>>({});
  sourceErrors = signal<Record<string, string>>({});
  sourcesCompleted = signal<string[]>([]);

  readonly pageSize = PAGE_SIZE;

  /** Total raw paper count across all sources (before dedup). */
  totalRaw = computed(() => {
    const bySource = this.rawPapersBySource();
    return Object.values(bySource).reduce((sum, papers) => sum + papers.length, 0);
  });

  /** All raw papers concatenated (for dedup). */
  private allRawPapers = computed(() => {
    const bySource = this.rawPapersBySource();
    const all: Paper[] = [];
    for (const papers of Object.values(bySource)) {
      all.push(...papers);
    }
    return all;
  });

  /** Deduplicated papers for the "All" view. */
  private dedupResult = computed(() => deduplicatePapers(this.allRawPapers()));

  deduplicatesRemoved = computed(() => this.dedupResult().duplicatesRemoved);

  /** Papers shown to the user — depends on active filter. */
  filteredPapers = computed(() => {
    const filter = this.activeFilter();
    if (!filter) {
      // "All" view: show deduplicated papers
      return this.dedupResult().papers;
    }
    // Per-source view: show exact papers from that source (no dedup)
    return this.rawPapersBySource()[filter] ?? [];
  });

  /** Count shown in the header — unique papers when unfiltered, source count when filtered. */
  totalFound = computed(() => this.filteredPapers().length);

  activeQuery = computed(() => {
    const filter = this.activeFilter();
    if (!filter) return null;
    return this.queriesUsed()[filter] ?? null;
  });

  activeError = computed(() => {
    const filter = this.activeFilter();
    if (!filter) return null;
    return this.sourceErrors()[filter] ?? null;
  });

  private lastQuery = '';

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      const q = params['q'] ?? '';
      const page = Number(params['page']) || 1;
      this.currentPage.set(page);

      // Only re-fetch when the search query itself changes, not on page changes
      if (q && q !== this.lastQuery) {
        this.lastQuery = q;
        this.rawQuery.set(q);
        this.runSearch(q);
      }
    });
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
  }

  onSearch(query: string): void {
    // Force re-fetch even if query is the same (user explicitly re-submitted)
    this.lastQuery = '';
    this.router.navigate(['/results'], {
      queryParams: { q: query, page: 1 },
    });
  }

  onFilterChange(source: string | null): void {
    this.activeFilter.set(source);
    this.currentPage.set(1);
  }

  onPageChange(page: number): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private runSearch(query: string): void {
    const keywords = parseQuery(query);
    if (!keywords.length) return;

    // Cancel any previous stream
    this.streamSub?.unsubscribe();

    // Reset state
    this.loading.set(true);
    this.error.set(null);
    this.activeFilter.set(null);
    this.rawPapersBySource.set({});
    this.sourcesQueried.set([]);
    this.sourcesFailed.set([]);
    this.sourcesCompleted.set([]);
    this.queriesUsed.set({});
    this.sourceErrors.set({});

    this.streamSub = this.retrieval.searchStream({ keywords, raw_query: query }).subscribe({
      next: (event) => {
        // Store raw papers keyed by source
        if (!event.failed && event.papers.length > 0) {
          this.rawPapersBySource.update(prev => ({
            ...prev,
            [event.source]: [...(prev[event.source] ?? []), ...event.papers],
          }));
        }

        // Track sources
        this.sourcesQueried.update(prev => [...prev, event.source]);
        this.sourcesCompleted.update(prev => [...prev, event.source]);

        if (event.failed) {
          this.sourcesFailed.update(prev => [...prev, event.source]);
          if (event.error_message) {
            this.sourceErrors.update(prev => ({ ...prev, [event.source]: event.error_message! }));
          }
        }

        // Track query used
        this.queriesUsed.update(prev => ({ ...prev, [event.source]: event.query_used }));
      },
      error: () => {
        this.error.set('Could not reach the search API. Make sure the backend is running on port 8000.');
        this.loading.set(false);
      },
      complete: () => {
        this.loading.set(false);
      },
    });
  }
}
