import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { RetrievalService } from '../../core/services/retrieval.service';
import { ScoringService } from '../../core/services/scoring.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { ScoreWeights } from '../../core/models/paper.model';
import { parseQuery } from '../../shared/utils/query-parser';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';
import { ResultsMetaComponent } from './results-meta/results-meta.component';
import { PaperListComponent } from './paper-list/paper-list.component';
import { PaginationComponent } from './pagination/pagination.component';

const PAGE_SIZE = 10;

/** Default weights used for auto-scoring on the results page. */
const DEFAULT_WEIGHTS: ScoreWeights = {
  w_c: 1.0,
  w_code: 1.0,
  w_peer: 1.0,
  w_data: 1.0,
  w_stars: 1.0,
};

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
  private readonly scoring = inject(ScoringService);
  readonly state = inject(SearchStateService);
  private streamSub: Subscription | null = null;
  private scoreSub: Subscription | null = null;

  readonly pageSize = PAGE_SIZE;

  private lastQuery = '';

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      const q = params['q'] ?? '';
      const page = Number(params['page']) || 1;
      this.state.currentPage.set(page);

      // Only re-fetch when the search query itself changes, not on page changes
      if (q && q !== this.lastQuery) {
        this.lastQuery = q;
        this.state.rawQuery.set(q);
        this.runSearch(q);
      }

      // If returning to this route with an existing query but no lastQuery
      // (component was freshly created), sync lastQuery to avoid re-fetch
      if (q && !this.lastQuery) {
        this.lastQuery = q;
      }
    });
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
    this.scoreSub?.unsubscribe();
  }

  onSearch(query: string): void {
    // Force re-fetch even if query is the same (user explicitly re-submitted)
    this.lastQuery = '';
    this.router.navigate(['/results'], {
      queryParams: { q: query, page: 1 },
    });
  }

  onFilterChange(source: string | null): void {
    this.state.activeFilter.set(source);
    this.state.currentPage.set(1);
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

    // Cancel any previous stream/scoring
    this.streamSub?.unsubscribe();
    this.scoreSub?.unsubscribe();

    // Reset state
    this.state.resetForNewSearch();

    this.streamSub = this.retrieval.searchStream({ keywords, raw_query: query }).subscribe({
      next: (event) => {
        // Store raw papers keyed by source
        if (!event.failed && event.papers.length > 0) {
          this.state.rawPapersBySource.update(prev => ({
            ...prev,
            [event.source]: [...(prev[event.source] ?? []), ...event.papers],
          }));
        }

        // Track sources
        this.state.sourcesQueried.update(prev => [...prev, event.source]);
        this.state.sourcesCompleted.update(prev => [...prev, event.source]);

        if (event.failed) {
          this.state.sourcesFailed.update(prev => [...prev, event.source]);
          if (event.error_message) {
            this.state.sourceErrors.update(prev => ({ ...prev, [event.source]: event.error_message! }));
          }
        }

        // Track query used
        this.state.queriesUsed.update(prev => ({ ...prev, [event.source]: event.query_used }));
      },
      error: () => {
        this.state.error.set('Could not reach the search API. Make sure the backend is running on port 8000.');
        this.state.loading.set(false);
      },
      complete: () => {
        this.state.loading.set(false);
        this.autoScorePapers();
      },
    });
  }

  /** After the stream completes, call the scoring endpoint to get relevancy scores. */
  private autoScorePapers(): void {
    if (this.state.totalRaw() === 0) return;

    this.state.scoresLoading.set(true);
    this.scoreSub = this.scoring.scorePapers(DEFAULT_WEIGHTS).subscribe({
      next: (res) => {
        const map: Record<string, number> = {};
        for (const sp of res.papers) {
          map[sp.title.toLowerCase()] = sp.relevancy_score;
        }
        this.state.scoresByTitle.set(map);
        this.state.scoresLoading.set(false);
      },
      error: () => {
        // Scoring is best-effort — don't block the UI
        this.state.scoresLoading.set(false);
      },
    });
  }
}
