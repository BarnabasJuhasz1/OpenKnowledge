import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { RetrievalService } from '../../core/services/retrieval.service';
import { ScoringService } from '../../core/services/scoring.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { DemoModeService } from '../../core/services/demo-mode.service';
import { ScoreWeights } from '../../core/models/paper.model';
import { parseQuery } from '../../shared/utils/query-parser';
import { ResultsMetaComponent } from './results-meta/results-meta.component';
import { PaperListComponent } from './paper-list/paper-list.component';
import { PaginationComponent } from './pagination/pagination.component';
import { FiltersSidebarComponent } from './filters-sidebar/filters-sidebar.component';

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
    ResultsMetaComponent,
    PaperListComponent,
    PaginationComponent,
    FiltersSidebarComponent,
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
  readonly demo = inject(DemoModeService);
  private streamSub: Subscription | null = null;
  private scoreSub: Subscription | null = null;
  private bgSub: Subscription | null = null;
  private demoSub: Subscription | null = null;

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
    this.bgSub?.unsubscribe();
    this.demoSub?.unsubscribe();
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

    // Cancel any previous subscriptions
    this.streamSub?.unsubscribe();
    this.scoreSub?.unsubscribe();
    this.bgSub?.unsubscribe();
    this.demoSub?.unsubscribe();

    // Reset state
    this.state.resetForNewSearch();

    if (this.demo.enabled()) {
      this.runDemoSearch(keywords, query);
    } else {
      this.runLiveSearch(keywords, query);
    }
  }

  private runDemoSearch(keywords: string[], query: string): void {
    this.demoSub = this.retrieval.demoSearch({
      keywords,
      raw_query: query,
    }).subscribe({
      next: (res) => {
        this.state.rawPapersBySource.set({ demo: res.papers });
        this.state.sourcesQueried.set(['demo']);
        this.state.sourcesCompleted.set(['demo']);
        this.state.queriesUsed.set(res.queries_used);
        this.state.loading.set(false);
      },
      error: () => {
        this.state.error.set('Could not reach the search API. Make sure the backend is running on port 8000.');
        this.state.loading.set(false);
      },
    });
  }

  private runLiveSearch(keywords: string[], query: string): void {
    this.streamSub = this.retrieval.searchStream({
      keywords,
      raw_query: query,
      max_initial_results: 1000,
      max_total_results: 10000,
      continue_in_background: true
    }).subscribe({
      next: (event) => {
        if ('type' in event && event.type === 'done') {
          if (event.data.background_job_id) {
            this.state.backgroundJobId.set(event.data.background_job_id);
            this.listenToBackgroundJob(event.data.background_job_id);
          }
          return;
        }

        const e = event as any;
        // Store raw papers keyed by source
        if (!e.failed && e.papers.length > 0) {
          this.state.rawPapersBySource.update(prev => ({
            ...prev,
            [e.source]: [...(prev[e.source] ?? []), ...e.papers],
          }));
        }

        // Track sources
        this.state.sourcesQueried.update(prev => [...prev, e.source]);
        this.state.sourcesCompleted.update(prev => [...prev, e.source]);

        if (e.failed) {
          this.state.sourcesFailed.update(prev => [...prev, e.source]);
          if (e.error_message) {
            this.state.sourceErrors.update(prev => ({ ...prev, [e.source]: e.error_message! }));
          }
        }

        // Track query used
        this.state.queriesUsed.update(prev => ({ ...prev, [e.source]: e.query_used }));
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

  /** After the stream completes, call the scoring endpoint to get OK-scores. */
  private autoScorePapers(): void {
    if (this.state.totalRaw() === 0) return;

    this.state.scoresLoading.set(true);
    this.scoreSub = this.scoring.scorePapers(DEFAULT_WEIGHTS).subscribe({
      next: (res) => {
        const map: Record<string, number> = {};
        for (const sp of res.papers) {
          map[sp.title.toLowerCase()] = sp.ok_score;
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

  private listenToBackgroundJob(jobId: string): void {
    this.bgSub?.unsubscribe();
    this.bgSub = this.retrieval.backgroundProgress(jobId).subscribe({
      next: (event) => {
        if (event.type === 'progress') {
          const prog = event.data;
          this.state.backgroundProgress.update(prev => ({
            ...prev,
            [prog.source]: prog,
          }));
        } else if (event.type === 'papers') {
          // Re-trigger auto-scoring now that we have all background papers
          // For simplicity, we just add them to the 'europe_pmc' or a 'background' bucket?
          // Actually, we should probably merge them in properly. The background endpoint
          // just gives us the *additional* papers. Let's add them to a special '__background__' source
          // so the dedup process picks them up.
          const papers = event.data.papers;
          this.state.rawPapersBySource.update(prev => ({
            ...prev,
            '__background__': [...(prev['__background__'] ?? []), ...papers],
          }));
          
          this.autoScorePapers();
        }
      },
      error: (err) => console.error("Background sync error:", err)
    });
  }
}
