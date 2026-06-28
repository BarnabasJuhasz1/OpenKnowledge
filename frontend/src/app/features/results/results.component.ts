import { Component, OnDestroy, OnInit, effect, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { RetrievalService, ScholarFiltersPayload } from '../../core/services/retrieval.service';
import { ScoringService } from '../../core/services/scoring.service';
import { SearchStateService, ALL_ARCHETYPES, ALL_SELECTABLE_FIELDS } from '../../core/services/search-state.service';
import { SearchModeService } from '../../core/services/search-mode.service';
import { ScoreWeights } from '../../core/models/paper.model';
import { parseQuery } from '../../shared/utils/query-parser';
import { environment } from '../../../environments/environment';
import { ResultsMetaComponent } from './results-meta/results-meta.component';
import { PaperListComponent } from './paper-list/paper-list.component';
import { PaginationComponent } from './pagination/pagination.component';
import { FiltersSidebarComponent } from './filters-sidebar/filters-sidebar.component';
import {
  SearchComposerComponent,
  GeneratedKeywords,
} from '../../shared/components/search-composer/search-composer.component';

const PAGE_SIZE = 10;
/** Scholar mode fetches and displays this many papers per server page. */
const SCHOLAR_PAGE_SIZE = 100;

/** The archetype classifier runs on-demand (Cloud Run scale-to-zero). If the first
 *  batch takes longer than this, we assume a cold start and surface a warm-up notice.
 *  Independent of the summaries' cold-start threshold. Env ARCHETYPE_COLD_START_NOTICE_SEC. */
const ARCHETYPE_COLD_START_NOTICE_MS =
  Math.max(1, Math.floor(environment.ARCHETYPE_COLD_START_NOTICE_SEC ?? 12)) * 1000;

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
    SearchComposerComponent,
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
  readonly mode = inject(SearchModeService);
  private streamSub: Subscription | null = null;
  private scoreSub: Subscription | null = null;
  private bgSub: Subscription | null = null;
  private demoSub: Subscription | null = null;
  /** Scholar mode: streams the ok-score-ordered archetype distribution. */
  private classifySub: Subscription | null = null;
  // Archetype-classifier cold-start warm-up notice: whether the current classify run
  // has received its first batch, the pending timer, and the threshold (overridable
  // in tests). Mirrors ClusterSummaryService's warm-up handling, but independent.
  private classifyFirstBatchSeen = false;
  private classifyWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  private classifyWarmupNoticeMs = ARCHETYPE_COLD_START_NOTICE_MS;
  /** Scholar mode: fetches field-of-study facet counts across the whole match set. */
  private facetSub: Subscription | null = null;

  readonly pageSize = PAGE_SIZE;

  private lastQuery = '';
  /** True once a Scholar page has loaded — gates the filter/sort refetch effect. */
  private scholarReady = false;
  private scholarRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private scholarPageReloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many 10-result UI pages fit in one fetched {@link SCHOLAR_PAGE_SIZE} window. */
  private readonly uiPagesPerScholarWindow = SCHOLAR_PAGE_SIZE / PAGE_SIZE;
  /** Which server window (1-based, {@link SCHOLAR_PAGE_SIZE} results each) is loaded. */
  private loadedScholarWindow = 0;

  constructor() {
    // Scholar mode: re-fetch page 1 from the server whenever a server-side filter changes
    // (so filters apply across ALL matches, not just the loaded page). A filter change narrows
    // the match set, so the distribution changes too — restart classification.
    // Debounced because range sliders emit a burst of changes while dragging.
    effect(() => {
      this.state.filters();        // track
      if (!this.mode.isScholar() || !this.scholarReady) return;
      this.scheduleScholarRefetch();
    });

    // A sort change only reorders the existing match set — it doesn't change which papers
    // match, so the archetype distribution is identical. Reload the page to reflect the new
    // order, but leave the classify stream (and its distribution panel) untouched.
    effect(() => {
      this.state.sortField();  // track
      if (!this.mode.isScholar() || !this.scholarReady) return;
      this.scheduleScholarPageReload();
    });

    // Archetype selection is filtered server-side across the whole match set. The classify
    // stream is NOT restarted: the underlying match-set archetype counts don't change, so the
    // distribution panel projects the selected subset out of the existing streamed counts
    // client-side (see archetypeDistribution). A change therefore only reloads the result
    // page. Debounced so toggling several archetypes coalesces into one fetch.
    effect(() => {
      this.state.selectedArchetypes();  // track
      if (!this.mode.isScholar() || !this.scholarReady) return;
      this.scheduleScholarPageReload();
    });

    // A field-of-study change narrows the match set server-side (unlike the archetype
    // filter, which is resolved from the classification cache without shrinking the index
    // match set). The distribution therefore changes too, so refetch AND restart classify.
    effect(() => {
      this.state.selectedFields();  // track
      if (!this.mode.isScholar() || !this.scholarReady) return;
      this.scheduleScholarRefetch();
    });
  }

  private scheduleScholarRefetch(): void {
    if (this.scholarRefetchTimer) clearTimeout(this.scholarRefetchTimer);
    // Mark a refetch as in flight immediately (not only when the debounce fires) so the
    // "filtered to N papers" count shows its updating spinner for the whole debounce window —
    // otherwise the count would sit silently stale until the request lands.
    this.state.loading.set(true);
    // Filters/sort changed — reload the first window from the server (force) and restart
    // classification, since the match set (and thus the distribution) has changed.
    this.scholarRefetchTimer = setTimeout(() => {
      this.loadScholarPage(1, true);
      this.startScholarClassify();
      this.loadScholarFacets();
    }, 350);
  }

  private scheduleScholarPageReload(): void {
    if (this.scholarPageReloadTimer) clearTimeout(this.scholarPageReloadTimer);
    // Show the updating spinner across the whole debounce window (see scheduleScholarRefetch).
    this.state.loading.set(true);
    // Sort or archetype filter changed — reload the first window from the server (to reorder,
    // or to apply the archetype filter across all matches). Neither alters the match set's
    // archetype distribution, so classification keeps running untouched.
    this.scholarPageReloadTimer = setTimeout(() => {
      this.loadScholarPage(1, true);
    }, 350);
  }

  /**
   * Within the currently loaded {@link SCHOLAR_PAGE_SIZE}-result window, which
   * {@link PAGE_SIZE}-paper slice the active UI page maps to (1-based). The
   * paper list client-paginates the loaded window by this local page.
   */
  scholarLocalPage(): number {
    return ((this.state.currentPage() - 1) % this.uiPagesPerScholarWindow) + 1;
  }

  /** Whether the current query produced any matches at all, before user filters.
   *  Scholar mode reports the stable unfiltered total; other modes count loaded papers. */
  get hasQueryMatches(): boolean {
    return this.mode.isScholar()
      ? this.state.scholarUnfilteredTotal() > 0
      : this.state.totalRaw() > 0;
  }

  /** The query matched papers, but the active filters narrow the result set to zero.
   *  Drives the "filtered to zero" notice (sidebar stays visible so filters can be undone). */
  get filteredToZero(): boolean {
    return this.hasQueryMatches && this.state.filteredPapers().length === 0;
  }

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      const q = params['q'] ?? '';
      const page = Number(params['page']) || 1;

      // Re-fetch only when the query itself changes.
      if (q && q !== this.lastQuery) {
        this.lastQuery = q;
        this.state.rawQuery.set(q);
        this.state.currentPage.set(page);
        this.runSearch(q);
      } else if (q && this.mode.isScholar() && page !== this.state.currentPage()) {
        // Same query, page navigation in Scholar mode → fetch that page from the server.
        this.loadScholarPage(page);
      } else {
        // Live/demo modes paginate client-side: just record the page.
        this.state.currentPage.set(page);
      }
    });
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
    this.scoreSub?.unsubscribe();
    this.bgSub?.unsubscribe();
    this.demoSub?.unsubscribe();
    this.classifySub?.unsubscribe();
    this.facetSub?.unsubscribe();
    this.clearClassifyWarmup();
    if (this.scholarRefetchTimer) clearTimeout(this.scholarRefetchTimer);
    if (this.scholarPageReloadTimer) clearTimeout(this.scholarPageReloadTimer);
  }

  onPageChange(page: number): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * A query submitted from the inline composer at the top of the page. Pushing a
   * new `q` (and resetting to page 1) updates the URL, which the `queryParams`
   * subscription in {@link ngOnInit} picks up and re-runs — refreshing the list
   * below without leaving the Results tab.
   */
  onComposerSearch(query: string): void {
    if (!query.trim()) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: query, page: 1 },
      queryParamsHandling: 'merge',
    });
  }

  /** AI-generated keywords fill the composer's keyword box for review (no auto-search). */
  onKeywordsGenerated(result: GeneratedKeywords): void {
    this.state.rawQuery.set(result.query);
  }

  private runSearch(query: string): void {
    const keywords = parseQuery(query);
    if (!keywords.length) return;

    // Cancel any previous subscriptions
    this.streamSub?.unsubscribe();
    this.scoreSub?.unsubscribe();
    this.bgSub?.unsubscribe();
    this.demoSub?.unsubscribe();
    this.classifySub?.unsubscribe();
    this.clearClassifyWarmup();

    // Reset state
    this.state.resetForNewSearch();

    // Scholar is the only mode reachable from the UI. The demo/live branches are kept for
    // reference but are deprecated and effectively dead (see SearchModeService).
    if (this.mode.isScholar()) {
      this.runScholarSearch(keywords, query);
    } else if (this.mode.isDemo()) {
      this.runDemoSearch(keywords, query);
    } else {
      this.runLiveSearch(keywords, query);
    }
  }

  /** @deprecated Demo mode is deprecated and unreachable from the UI. */
  private runDemoSearch(keywords: string[], query: string): void {
    // Demo holds the full result set client-side, so archetypes are filtered client-side.
    this.state.serverSideArchetypeFilter.set(false);
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

  /** Semantic Scholar mode: server-paginated boolean search.
   *
   * A new search loads the first page (top {@link SCHOLAR_PAGE_SIZE} by ok-score) plus the
   * exact total. Only the current page is held client-side; other pages are fetched on
   * demand (see {@link loadScholarPage}). Filters/sort are applied server-side across the
   * whole match set.
   */
  private runScholarSearch(_keywords: string[], _query: string): void {
    this.scholarReady = false;
    this.loadedScholarWindow = 0;
    // Scholar holds one page; archetype filtering is applied server-side across all matches.
    this.state.serverSideArchetypeFilter.set(true);
    this.loadScholarPage(this.state.currentPage());
    // Independently of paging, classify the whole match set (top ok-score first) so the
    // archetype distribution fills in batch by batch across all results, not just one page.
    this.startScholarClassify();
    // Field-of-study counts across the whole match set (the loaded page is too small a
    // sample), so the filter dropdown shows real counts + the Miscellaneous bucket.
    this.loadScholarFacets();
  }

  /**
   * Fetch field-of-study facet counts for the current Scholar query + filters across the
   * whole match set. The field selection is intentionally ignored server-side so toggling
   * fields never prunes the option list; other filters (year, citation, etc.) still apply.
   */
  private loadScholarFacets(): void {
    const query = this.state.rawQuery();
    const keywords = parseQuery(query);
    if (!keywords.length) return;

    this.facetSub?.unsubscribe();
    this.facetSub = this.retrieval.scholarFieldFacets(
      { keywords, raw_query: query },
      this.state.sortField(),
      this.buildScholarFilters(),
    ).subscribe({
      next: (res) => this.state.fieldFacets.set(res),
      // Best-effort — facet counts are advisory; a failure just leaves the previous counts.
      error: () => {},
    });
  }

  /**
   * (Re)start the archetype classification stream for the current Scholar query + filters.
   * The backend pages the match set in descending ok-score order, classifies each batch via
   * the remote model, and streams a growing distribution + per-paper archetypes — so the
   * distribution panel updates after every batch and loaded paper cards get their badges.
   * Best-effort: the distribution is optional and never blocks the results list.
   */
  private startScholarClassify(): void {
    this.classifySub?.unsubscribe();
    this.clearClassifyWarmup();
    const query = this.state.rawQuery();
    const keywords = parseQuery(query);
    if (!keywords.length) return;

    this.state.scholarArchetypeCounts.set({});
    // Mark the distribution panel as "classifying" immediately, before the first batch lands,
    // so it shows an in-progress template rather than staying hidden.
    this.state.scholarClassifyProgress.set({ status: 'running', classified: 0, total: 0 });
    this.armClassifyWarmup();
    this.classifySub = this.retrieval.scholarClassifyStream(
      { keywords, raw_query: query },
      this.state.sortField(),
      this.buildScholarFilters(),
    ).subscribe({
      next: (event) => {
        if (event.type === 'distribution' || event.type === 'done') {
          // First batch arrived — the classifier is warm, so drop the warm-up notice.
          this.markClassifyFirstBatch();
          this.state.scholarArchetypeCounts.set(event.counts);
          this.state.scholarClassifyProgress.set({
            status: event.type === 'done' ? 'done' : 'running',
            classified: event.classified,
            total: event.total,
          });
        } else if (event.type === 'archetypes') {
          this.state.applyArchetypes(event.data);
        }
      },
      error: () => {
        // Best-effort — a failed classify stream must not disturb results; just stop
        // advertising it as in-progress so the panel settles on whatever arrived.
        this.clearClassifyWarmup();
        this.state.scholarClassifyProgress.update(p => ({ ...p, status: 'done' }));
      },
      complete: () => {
        this.clearClassifyWarmup();
        this.state.scholarClassifyProgress.update(p => ({ ...p, status: 'done' }));
      },
    });
  }

  // --- archetype-classifier cold-start warm-up notice ------------------------
  // The classifier is a separate on-demand (Cloud Run scale-to-zero) service, so it
  // cold-starts independently of the summarization model. If the first batch is
  // overdue, surface a "please be patient" notice (mirrors ClusterSummaryService).

  /** Arm the warm-up notice: if no batch arrives within the threshold, the classifier
   *  is likely cold-starting, so show the notice. */
  private armClassifyWarmup(): void {
    this.clearClassifyWarmup();
    this.classifyFirstBatchSeen = false;
    this.classifyWarmupTimer = setTimeout(() => {
      this.classifyWarmupTimer = null;
      if (!this.classifyFirstBatchSeen) this.state.scholarClassifyWarmingUp.set(true);
    }, this.classifyWarmupNoticeMs);
  }

  /** First batch arrived — the classifier is warm, so cancel the pending notice and
   *  hide any that already showed. */
  private markClassifyFirstBatch(): void {
    if (this.classifyFirstBatchSeen) return;
    this.classifyFirstBatchSeen = true;
    this.clearClassifyWarmup();
  }

  /** User-dismissed the warm-up notice: hide it (and cancel any pending timer so
   *  it won't reappear for the current classify run). */
  dismissClassifyWarmup(): void {
    this.clearClassifyWarmup();
  }

  /** Cancel any pending warm-up timer and hide the notice. */
  private clearClassifyWarmup(): void {
    if (this.classifyWarmupTimer !== null) {
      clearTimeout(this.classifyWarmupTimer);
      this.classifyWarmupTimer = null;
    }
    this.state.scholarClassifyWarmingUp.set(false);
  }

  /** Map the shared filter UI state onto the server-side ScholarFilters payload.
   *
   * `includeArchetypes` is set only for the results page fetch: the backend resolves
   * archetype membership from the live classification cache and filters the whole match set.
   * The classify stream omits archetypes so its distribution still spans every archetype.
   * A non-strict selection (all archetypes) sends `null` so the fast index path is used.
   * code-only stays off: that index field isn't backfilled yet.
   */
  /** Whether any user filter that narrows the server-side match set is active.
   *  (Sort doesn't change the total, so it's excluded.) Used to decide whether a
   *  fetched total reflects the full query or a filtered subset. */
  private hasActiveScholarFilters(): boolean {
    const f = this.state.filters();
    const selectedArchs = this.state.selectedArchetypes();
    const selectedFields = this.state.selectedFields();
    return f.yearMin != null || f.yearMax != null
      || f.citationMin != null || f.citationMax != null
      || f.openAccessOnly || f.peerReviewedOnly
      || (selectedArchs.size > 0 && selectedArchs.size < ALL_ARCHETYPES.length)
      || (selectedFields.size > 0 && selectedFields.size < ALL_SELECTABLE_FIELDS.length);
  }

  private buildScholarFilters(includeArchetypes = false): ScholarFiltersPayload {
    const f = this.state.filters();
    let archetypes: string[] | null = null;
    if (includeArchetypes) {
      const selected = this.state.selectedArchetypes();
      if (selected.size > 0 && selected.size < ALL_ARCHETYPES.length) {
        archetypes = Array.from(selected);
      }
    }
    // Field of study is a real index filter, so it applies to BOTH the page fetch and the
    // classify stream (so the distribution reflects the field-narrowed match set). All
    // selected → null, so the fast unfiltered index path is kept.
    let fieldsOfStudy: string[] | null = null;
    const selectedFields = this.state.selectedFields();
    if (selectedFields.size > 0 && selectedFields.size < ALL_SELECTABLE_FIELDS.length) {
      // Carries the 'Miscellaneous' sentinel through to the backend, which maps it to the
      // "no field of study" (missing) case.
      fieldsOfStudy = Array.from(selectedFields);
    }
    return {
      year_min: f.yearMin,
      year_max: f.yearMax,
      citation_min: f.citationMin,
      citation_max: f.citationMax,
      open_access_only: f.openAccessOnly,
      peer_reviewed_only: f.peerReviewedOnly,
      code_only: false,
      archetypes,
      fields_of_study: fieldsOfStudy,
    };
  }

  /**
   * Navigate to a UI page (10 results each). The server is queried
   * {@link SCHOLAR_PAGE_SIZE} results at a time; this maps the UI page onto the
   * containing server window and only refetches when that window changes (or
   * when `forceFetch` is set, e.g. after a filter/sort change). Paging within an
   * already-loaded window just updates the slice — no network round-trip.
   */
  /** An empty archetype or field selection means "match nothing": the backend reads an
   *  empty filter list as "no filter" and would return everything, so we never fetch and
   *  instead settle on a zero-result (filtered-to-zero) state. */
  private scholarSelectionEmpty(): boolean {
    return this.state.selectedArchetypes().size === 0
      || this.state.selectedFields().size === 0;
  }

  private loadScholarPage(page: number, forceFetch = false): void {
    const query = this.state.rawQuery();
    const keywords = parseQuery(query);
    if (!keywords.length) return;

    this.state.currentPage.set(page);

    // Filtered to zero by an empty archetype/field selection — show no results without
    // a round-trip (the query's unfiltered total stays put so the sidebar/layout remain).
    if (this.scholarSelectionEmpty()) {
      this.demoSub?.unsubscribe();
      this.state.rawPapersBySource.set({ semantic_scholar: [] });
      this.state.sourcesCompleted.set(['semantic_scholar']);
      this.state.scholarTotal.set(0);
      this.state.scholarHasMore.set(false);
      this.state.loading.set(false);
      this.state.error.set(null);
      this.scholarReady = true;
      this.loadedScholarWindow = 0;
      return;
    }

    const serverWindow = Math.ceil(page / this.uiPagesPerScholarWindow);
    // Reuse the loaded 100-result window when paging within it.
    if (!forceFetch && this.scholarReady && serverWindow === this.loadedScholarWindow) {
      return;
    }

    this.loadedScholarWindow = serverWindow;
    this.state.loading.set(true);
    this.state.error.set(null);
    this.state.sourcesQueried.set(['semantic_scholar']);

    this.demoSub?.unsubscribe();
    this.demoSub = this.retrieval.scholarSearchPage(
      { keywords, raw_query: query },
      serverWindow,
      SCHOLAR_PAGE_SIZE,
      this.state.sortField(),
      this.buildScholarFilters(true),
    ).subscribe({
      next: (res) => {
        this.state.rawPapersBySource.set({ semantic_scholar: res.papers });
        this.state.sourcesCompleted.set(['semantic_scholar']);
        this.state.queriesUsed.set(res.queries_used);
        this.state.scholarTotal.set(res.total_found);
        // Keep the "papers found" figure stable across filtering: only an unfiltered
        // fetch reflects the full query total, so capture it only then.
        if (!this.hasActiveScholarFilters()) {
          this.state.scholarUnfilteredTotal.set(res.total_found);
        }
        this.state.scholarHasMore.set(res.has_more);
        this.state.scholarResultCap.set(res.result_cap);
        this.state.loading.set(false);
        this.scholarReady = true;
      },
      error: (err) => {
        const detail = err?.error?.detail;
        this.state.error.set(
          detail
            ? `Semantic Scholar search failed: ${detail}`
            : 'Could not reach the search API. Make sure the backend is running on port 8000.'
        );
        this.state.loading.set(false);
      },
    });
  }

  /** @deprecated Live mode is deprecated and unreachable from the UI. */
  private runLiveSearch(keywords: string[], query: string): void {
    // Live mode accumulates all streamed papers client-side; filter archetypes client-side.
    this.state.serverSideArchetypeFilter.set(false);
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

        if ('type' in event && event.type === 'archetypes') {
          this.state.applyArchetypes(event.data);
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
