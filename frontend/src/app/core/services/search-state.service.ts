import { Injectable, computed, signal } from '@angular/core';
import { Paper, ScoreWeights, BackgroundProgress } from '../models/paper.model';
import { deduplicatePapers } from '../../shared/utils/dedup-papers';

function computeOkScore(p: Paper, w: ScoreWeights): number {
  const citations = p.citation_count ?? 0;
  const hasCode = p.has_public_code ? 1 : 0;
  const isPeer = p.is_peer_reviewed ? 1 : 0;
  const hasData = p.has_dataset ? 1 : 0;
  const stars = p.repo_stars ?? 0;
  return +(
    w.w_c * Math.log10(1 + citations)
    + w.w_code * hasCode
    + w.w_peer * isPeer
    + w.w_data * hasData
    + w.w_stars * Math.log10(1 + stars)
  ).toFixed(2);
}

export type SortField = 'relevancy' | 'year_desc' | 'year_asc' | 'citations_desc' | 'citations_asc' | 'title_asc';

export interface FilterState {
  yearMin: number | null;
  yearMax: number | null;
  citationMin: number | null;
  citationMax: number | null;
  codeOnly: boolean;
  peerReviewedOnly: boolean;
  openAccessOnly: boolean;
}

export function paperId(p: Paper): string {
  return p.doi || p.arxiv_id || p.semantic_scholar_id || p.openalex_id || p.title;
}

export const ALL_SOURCES = [
  'openalex', 'semantic_scholar', 'arxiv', 'europe_pmc',
  'dblp', 'crossref', 'core', 'pubmed', 'demo',
] as const;

export const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  openalex: 'OpenAlex',
  semantic_scholar: 'Semantic Scholar',
  arxiv: 'arXiv',
  europe_pmc: 'Europe PMC',
  dblp: 'DBLP',
  crossref: 'CrossRef',
  core: 'CORE',
  pubmed: 'PubMed',
  demo: 'Demo',
};

export interface SourceStatus {
  name: string;
  displayName: string;
  paperCount: number;
  isSearching: boolean;
  hasFailed: boolean;
  errorMessage: string | null;
}

@Injectable({ providedIn: 'root' })
export class SearchStateService {
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

  readonly scoresByTitle = signal<Record<string, number>>({});
  readonly scoresLoading = signal(false);

  readonly backgroundJobId = signal<string | null>(null);
  readonly backgroundProgress = signal<Record<string, BackgroundProgress>>({});
  readonly backgroundLoading = computed(() => {
    const job = this.backgroundJobId();
    if (!job) return false;
    const progress = this.backgroundProgress();
    // If no progress events yet but job exists, it's loading
    if (Object.keys(progress).length === 0) return true;
    // Loading if the "__all__" source is not complete
    return progress['__all__']?.is_complete !== true;
  });

  readonly graphPaperIds = signal<Set<string>>(new Set());
  graphInitialized = false;

  readonly sortField = signal<SortField>('relevancy');
  readonly filters = signal<FilterState>({
    yearMin: null,
    yearMax: null,
    citationMin: null,
    citationMax: null,
    codeOnly: false,
    peerReviewedOnly: false,
    openAccessOnly: false,
  });

  readonly totalRaw = computed(() => {
    const bySource = this.rawPapersBySource();
    return Object.values(bySource).reduce((sum, papers) => sum + papers.length, 0);
  });

  private readonly allRawPapers = computed(() => {
    const bySource = this.rawPapersBySource();
    const all: Paper[] = [];
    for (const papers of Object.values(bySource)) {
      all.push(...papers);
    }
    return all;
  });

  private readonly dedupResult = computed(() => deduplicatePapers(this.allRawPapers()));

  readonly deduplicatesRemoved = computed(() => this.dedupResult().duplicatesRemoved);

  private static readonly DEFAULT_WEIGHTS: ScoreWeights = {
    w_c: 1.0, w_code: 1.0, w_peer: 1.0, w_data: 1.0, w_stars: 1.0,
  };

  /** Computed range bounds from the data, used to populate slider defaults. */
  readonly yearRange = computed(() => {
    const papers = this.scoredPapers();
    let min = Infinity, max = -Infinity;
    for (const p of papers) {
      if (p.year != null) {
        if (p.year < min) min = p.year;
        if (p.year > max) max = p.year;
      }
    }
    return min <= max ? { min, max } : { min: 2000, max: 2026 };
  });

  readonly citationRange = computed(() => {
    const papers = this.scoredPapers();
    let max = 0;
    for (const p of papers) {
      const c = p.citation_count ?? 0;
      if (c > max) max = c;
    }
    return { min: 0, max: max || 100 };
  });

  /** Papers with scores attached (before filtering/sorting). */
  private readonly scoredPapers = computed(() => {
    const filter = this.activeFilter();
    let papers: Paper[];
    if (!filter) {
      papers = this.dedupResult().papers;
    } else {
      papers = this.rawPapersBySource()[filter] ?? [];
    }
    const scores = this.scoresByTitle();
    const w = SearchStateService.DEFAULT_WEIGHTS;
    return papers.map(p => {
      const key = p.title.toLowerCase();
      const backendScore = scores[key];
      const score = backendScore ?? computeOkScore(p, w);
      if (p.ok_score !== score) {
        return { ...p, ok_score: score };
      }
      return p;
    });
  });

  /** Scored papers before any filtering — used by the graph view. */
  readonly allScoredPapers = computed(() => this.scoredPapers());

  /** Papers after filtering and sorting. */
  readonly filteredPapers = computed(() => {
    const papers = this.scoredPapers();
    const f = this.filters();
    const sort = this.sortField();

    let result = papers.filter(p => {
      if (f.yearMin != null && (p.year == null || p.year < f.yearMin)) return false;
      if (f.yearMax != null && (p.year == null || p.year > f.yearMax)) return false;
      if (f.citationMin != null && (p.citation_count ?? 0) < f.citationMin) return false;
      if (f.citationMax != null && (p.citation_count ?? 0) > f.citationMax) return false;
      if (f.codeOnly && !p.has_public_code && !p.code_url) return false;
      if (f.peerReviewedOnly && !p.is_peer_reviewed) return false;
      if (f.openAccessOnly && !p.is_open_access) return false;
      return true;
    });

    result = [...result].sort((a, b) => {
      switch (sort) {
        case 'relevancy':
          return (b.ok_score ?? 0) - (a.ok_score ?? 0);
        case 'year_desc':
          return (b.year ?? 0) - (a.year ?? 0);
        case 'year_asc':
          return (a.year ?? 0) - (b.year ?? 0);
        case 'citations_desc':
          return (b.citation_count ?? 0) - (a.citation_count ?? 0);
        case 'citations_asc':
          return (a.citation_count ?? 0) - (b.citation_count ?? 0);
        case 'title_asc':
          return a.title.localeCompare(b.title);
        default:
          return 0;
      }
    });

    return result;
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

  readonly hasSearched = computed(() => this.rawQuery() !== '');

  readonly sourceStatuses = computed<SourceStatus[]>(() => {
    const loading = this.loading();
    const completed = this.sourcesCompleted();
    const failed = this.sourcesFailed();
    const errors = this.sourceErrors();
    const bySource = this.rawPapersBySource();
    const bgProgress = this.backgroundProgress();

    return ALL_SOURCES.map(name => {
      const pCount = (bySource[name] ?? []).length;
      const pBg = bgProgress[name];
      const isBgLoading = pBg ? !pBg.is_complete : false;
      return {
        name,
        displayName: SOURCE_DISPLAY_NAMES[name] || name,
        paperCount: pCount,
        isSearching: (loading && !completed.includes(name)) || isBgLoading,
        hasFailed: failed.includes(name),
        errorMessage: errors[name] ?? null,
      };
    });
  });

  isInGraph(paper: Paper): boolean {
    return this.graphPaperIds().has(paperId(paper));
  }

  addToGraph(paper: Paper): void {
    const id = paperId(paper);
    if (!this.graphPaperIds().has(id)) {
      this.graphPaperIds.update(prev => new Set([...prev, id]));
    }
  }

  removeFromGraph(id: string): void {
    this.graphPaperIds.update(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  updateFilter(partial: Partial<FilterState>): void {
    this.filters.update(prev => ({ ...prev, ...partial }));
    this.currentPage.set(1);
  }

  resetFilters(): void {
    this.filters.set({
      yearMin: null,
      yearMax: null,
      citationMin: null,
      citationMax: null,
      codeOnly: false,
      peerReviewedOnly: false,
      openAccessOnly: false,
    });
    this.sortField.set('relevancy');
    this.currentPage.set(1);
  }

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
    this.backgroundJobId.set(null);
    this.backgroundProgress.set({});
    this.graphPaperIds.set(new Set());
    this.graphInitialized = false;
    this.resetFilters();
  }
}
