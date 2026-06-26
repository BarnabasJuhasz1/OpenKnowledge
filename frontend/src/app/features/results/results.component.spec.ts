import { describe, beforeEach, it, expect } from 'vitest';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of, Subject } from 'rxjs';
import { ResultsComponent } from './results.component';
import {
  RetrievalService,
  ScholarFiltersPayload,
  ScholarPageResponse,
  ScholarFacetsResponse,
  ScholarClassifyEvent,
} from '../../core/services/retrieval.service';
import { ScoringService } from '../../core/services/scoring.service';
import { SearchStateService } from '../../core/services/search-state.service';

function pageResponse(total: number): ScholarPageResponse {
  return {
    papers: [],
    total_found: total,
    page: 1,
    page_size: 100,
    has_more: false,
    queries_used: { semantic_scholar: 'learning' },
    result_cap: 10000,
  };
}

/** Give the debounced (350ms) Scholar refetch time to fire. */
const REFETCH_DEBOUNCE_MS = 500;

describe('ResultsComponent — Scholar show-only filters drive a server refetch', () => {
  let pageFilters: ScholarFiltersPayload[];
  let classifyFilters: ScholarFiltersPayload[];
  let facetFilters: ScholarFiltersPayload[];
  let state: SearchStateService;
  let appRef: ApplicationRef;

  beforeEach(() => {
    pageFilters = [];
    classifyFilters = [];
    facetFilters = [];

    const retrievalStub: Partial<RetrievalService> = {
      scholarSearchPage: (_req, _page, _size, _sort, filters) => {
        pageFilters.push(filters);
        // Mirror the real backend: the filtered total differs from the unfiltered one.
        const filtered = filters.peer_reviewed_only || filters.open_access_only;
        return of(pageResponse(filtered ? 2_788_623 : 4_688_327));
      },
      scholarClassifyStream: (_req, _sort, filters) => {
        classifyFilters.push(filters);
        // A filtered match set yields a different distribution than the unfiltered one,
        // so we can assert the panel actually reacts (not just that a call was made).
        const filtered = filters.peer_reviewed_only || filters.open_access_only;
        const counts: Record<string, number> = filtered
          ? { 'The Analyst': 5 }
          : { 'The Innovator': 10 };
        return of({ type: 'done', counts, classified: 0, total: 0 } as ScholarClassifyEvent);
      },
      scholarFieldFacets: (_req, _sort, filters) => {
        facetFilters.push(filters);
        return of({
          fields: {}, miscellaneous: 0, total: 0, year_min: null, year_max: null,
        } as ScholarFacetsResponse);
      },
    };

    TestBed.configureTestingModule({
      imports: [ResultsComponent],
      providers: [
        provideRouter([]),
        { provide: RetrievalService, useValue: retrievalStub },
        { provide: ScoringService, useValue: { scorePapers: () => of({ papers: [] }) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({ q: 'learning', page: 1 }) } },
      ],
    });
    state = TestBed.inject(SearchStateService);
    appRef = TestBed.inject(ApplicationRef);
  });

  /** Run the initial Scholar search so the page is loaded and `scholarReady` is set. */
  function loadInitialSearch(): void {
    const fixture = TestBed.createComponent(ResultsComponent);
    fixture.detectChanges(); // ngOnInit → route emits → initial Scholar load
    appRef.tick();           // flush the constructor effects
    expect(pageFilters.length).toBeGreaterThanOrEqual(1);
    expect(pageFilters[0].peer_reviewed_only).toBeFalsy();
    expect(pageFilters[0].open_access_only).toBeFalsy();
  }

  it('refetches page + classify + facets with peer_reviewed_only when the toggle is set', async () => {
    loadInitialSearch();
    const pageBefore = pageFilters.length;

    state.updateFilter({ peerReviewedOnly: true });
    appRef.tick(); // flush the filters() effect → schedule the debounced refetch

    await new Promise(r => setTimeout(r, REFETCH_DEBOUNCE_MS));

    // The page total, classify stream (distribution) and facets are all re-fetched
    // server-side with the filter applied — so the count and distribution reflect it.
    expect(pageFilters.length).toBeGreaterThan(pageBefore);
    expect(pageFilters.at(-1)!.peer_reviewed_only).toBe(true);
    expect(classifyFilters.at(-1)!.peer_reviewed_only).toBe(true);
    expect(facetFilters.at(-1)!.peer_reviewed_only).toBe(true);

    // Symptom 1: the "filtered to N" count reflects the filtered total, while the stable
    // "papers found" figure stays at the unfiltered total.
    expect(state.scholarTotal()).toBe(2_788_623);
    expect(state.scholarUnfilteredTotal()).toBe(4_688_327);
    // Symptom 2: the archetype distribution reflects the filtered match set.
    expect(state.scholarArchetypeCounts()).toEqual({ 'The Analyst': 5 });
  });

  it('refetches page + classify + facets with open_access_only when the toggle is set', async () => {
    loadInitialSearch();
    const pageBefore = pageFilters.length;

    state.updateFilter({ openAccessOnly: true });
    appRef.tick();

    await new Promise(r => setTimeout(r, REFETCH_DEBOUNCE_MS));

    expect(pageFilters.length).toBeGreaterThan(pageBefore);
    expect(pageFilters.at(-1)!.open_access_only).toBe(true);
    expect(classifyFilters.at(-1)!.open_access_only).toBe(true);
    expect(facetFilters.at(-1)!.open_access_only).toBe(true);

    expect(state.scholarTotal()).toBe(2_788_623);
    expect(state.scholarUnfilteredTotal()).toBe(4_688_327);
    expect(state.scholarArchetypeCounts()).toEqual({ 'The Analyst': 5 });
  });
});

describe('ResultsComponent — full-screen loader stays out of filter refetches', () => {
  let state: SearchStateService;
  let appRef: ApplicationRef;

  beforeEach(() => {
    const retrievalStub: Partial<RetrievalService> = {
      scholarSearchPage: () => of(pageResponse(4_688_327)),
      scholarClassifyStream: () =>
        of({ type: 'done', counts: {}, classified: 0, total: 0 } as ScholarClassifyEvent),
      scholarFieldFacets: () =>
        of({ fields: {}, miscellaneous: 0, total: 0, year_min: null, year_max: null } as ScholarFacetsResponse),
    };

    TestBed.configureTestingModule({
      imports: [ResultsComponent],
      providers: [
        provideRouter([]),
        { provide: RetrievalService, useValue: retrievalStub },
        { provide: ScoringService, useValue: { scorePapers: () => of({ papers: [] }) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({ q: 'learning', page: 1 }) } },
      ],
    });
    state = TestBed.inject(SearchStateService);
    appRef = TestBed.inject(ApplicationRef);
  });

  // Regression: disabling all archetypes empties the loaded papers (totalRaw → 0) while the
  // query's unfiltered total stays put; re-enabling one forces a refetch (loading → true).
  // The full-screen "Searching Academic Databases" loader must NOT reappear on top of the
  // already-rendered results area — it is only for the initial, match-less search.
  it('does not show the full-screen loader during a filter-driven refetch', () => {
    const fixture = TestBed.createComponent(ResultsComponent);
    fixture.detectChanges(); // initial Scholar load completes → unfiltered total is set
    appRef.tick();
    expect(state.scholarUnfilteredTotal()).toBeGreaterThan(0);

    // Mid-refetch state: a result-narrowing filter cleared the loaded page and a new fetch
    // is in flight, so loading is true and totalRaw is 0 — the exact trigger for the bug.
    state.rawPapersBySource.set({ semantic_scholar: [] });
    state.loading.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.search-loader')).toBeNull();
  });

  it('shows the full-screen loader on the initial, match-less search', () => {
    const fixture = TestBed.createComponent(ResultsComponent);
    fixture.detectChanges(); // initial load runs synchronously via the stub
    appRef.tick();

    // Before any results: loading with no matches yet → the loader is the whole page.
    state.scholarUnfilteredTotal.set(0);
    state.rawPapersBySource.set({});
    state.loading.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.search-loader')).not.toBeNull();
  });
});

describe('ResultsComponent — archetype classifier cold-start warm-up notice', () => {
  let state: SearchStateService;
  let appRef: ApplicationRef;
  // Gate the classify stream so the first batch can be withheld (simulating a cold start)
  // and released on demand — the warm-up notice keys off the first-batch delay.
  let classifyStream: Subject<ScholarClassifyEvent>;

  beforeEach(() => {
    classifyStream = new Subject<ScholarClassifyEvent>();

    const retrievalStub: Partial<RetrievalService> = {
      scholarSearchPage: () => of(pageResponse(4_688_327)),
      // Withhold the first batch until the test releases it, so the warm-up timer can fire.
      scholarClassifyStream: () => classifyStream.asObservable(),
      scholarFieldFacets: () =>
        of({ fields: {}, miscellaneous: 0, total: 0, year_min: null, year_max: null } as ScholarFacetsResponse),
    };

    TestBed.configureTestingModule({
      imports: [ResultsComponent],
      providers: [
        provideRouter([]),
        { provide: RetrievalService, useValue: retrievalStub },
        { provide: ScoringService, useValue: { scorePapers: () => of({ papers: [] }) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({ q: 'learning', page: 1 }) } },
      ],
    });
    state = TestBed.inject(SearchStateService);
    appRef = TestBed.inject(ApplicationRef);
  });

  it('shows the warm-up notice when the first batch is overdue, then hides it once it arrives', async () => {
    const fixture = TestBed.createComponent(ResultsComponent);
    // Tighten the cold-start threshold so the test doesn't wait the real seconds.
    (fixture.componentInstance as any).classifyWarmupNoticeMs = 30;
    fixture.detectChanges(); // ngOnInit → initial Scholar load → startScholarClassify arms the timer
    appRef.tick();

    // No batch yet, but the threshold hasn't elapsed — notice stays hidden.
    expect(state.scholarClassifyWarmingUp()).toBe(false);

    // Let the 30ms threshold lapse with no batch — the classifier looks cold-started.
    await new Promise(r => setTimeout(r, 60));
    expect(state.scholarClassifyWarmingUp()).toBe(true);

    // First batch arrives — the classifier is warm, so the notice clears.
    classifyStream.next({ type: 'done', counts: { 'The Innovator': 10 }, classified: 0, total: 0 });
    expect(state.scholarClassifyWarmingUp()).toBe(false);
  });

  it('keeps the warm-up notice hidden when the first batch arrives promptly', async () => {
    const fixture = TestBed.createComponent(ResultsComponent);
    (fixture.componentInstance as any).classifyWarmupNoticeMs = 1000;
    fixture.detectChanges();
    appRef.tick();

    // Batch lands well before the (1s) threshold — notice never shows.
    classifyStream.next({ type: 'distribution', counts: { 'The Innovator': 10 }, classified: 5, total: 10 });
    await new Promise(r => setTimeout(r, 40));
    expect(state.scholarClassifyWarmingUp()).toBe(false);
  });

  it('exposes archetype-specific cold-start notice copy', () => {
    expect(state.archetypeColdStartNotice.toLowerCase()).toContain('patient');
    expect(state.archetypeColdStartNotice.toLowerCase()).toContain('archetype');
  });
});
