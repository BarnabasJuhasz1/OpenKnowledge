import { Injectable, computed, effect, signal } from '@angular/core';
import { Paper, ScoreWeights, BackgroundProgress } from '../models/paper.model';
import { deduplicatePapers } from '../../shared/utils/dedup-papers';
import { parseQuery } from '../../shared/utils/query-parser';
import { environment } from '../../../environments/environment';

// Alpha: `has_public_code`, `has_dataset` and `repo_stars` are not backfilled in the live
// index, so those terms are inert (default to 0) and the score reduces to
// `log10(1+citations) + isPeer` — exactly the backend `function_score` ranking. The terms
// are kept here so scoring lights up automatically once a backfill lands.
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

/** Progress of the Scholar archetype classification stream. */
export interface ScholarClassifyProgress {
  /** `idle` before any stream, `running` while batches are being classified,
   *  `done` once the whole match set is classified (or the stream ended). */
  status: 'idle' | 'running' | 'done';
  /** Number of retrieved papers classified so far. */
  classified: number;
  /** Total number of retrieved papers to classify (the ok-score-capped match set). */
  total: number;
}

export interface FilterState {
  yearMin: number | null;
  yearMax: number | null;
  citationMin: number | null;
  citationMax: number | null;
  codeOnly: boolean;
  peerReviewedOnly: boolean;
  openAccessOnly: boolean;
}

export const ALL_ARCHETYPES = [
  'The Innovator',
  'The Evaluator',
  'The Combiner',
  'The Analyst',
  'The Synthesizer',
  'The Translator',
  'The Architect',
  'The Resource Creator',
] as const;

/** Canonical Semantic Scholar field-of-study taxonomy. Fixed (like {@link ALL_ARCHETYPES}
 *  and {@link ALL_SOURCES}), so the filter options can be hard-coded rather than aggregated
 *  from the index. Values match exactly what's stored in `fields_of_study`. */
export const ALL_FIELDS_OF_STUDY = [
  'Computer Science',
  'Medicine',
  'Biology',
  'Chemistry',
  'Physics',
  'Materials Science',
  'Mathematics',
  'Engineering',
  'Environmental Science',
  'Agricultural and Food Sciences',
  'Geology',
  'Geography',
  'Psychology',
  'Sociology',
  'Political Science',
  'Economics',
  'Business',
  'Education',
  'Law',
  'Linguistics',
  'Philosophy',
  'History',
  'Art',
] as const;

/** Synthetic bucket for papers that carry no field of study (Semantic Scholar didn't assign
 *  one). Selectable + filterable alongside the canonical fields; matched server-side as the
 *  "no field" case. Kept separate from {@link ALL_FIELDS_OF_STUDY} (which mirrors the index
 *  values exactly) so the two never get confused. */
export const MISC_FIELD = 'Miscellaneous';

/** Everything the field-of-study filter can select: the canonical fields plus Miscellaneous. */
export const ALL_SELECTABLE_FIELDS = [...ALL_FIELDS_OF_STUDY, MISC_FIELD] as const;

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

/** Copy-only knob for the archetype-classifier warm-up notice: roughly how long a
 *  cold load takes. Independent of the summaries' SUMMARY_WARMUP_MINUTES. */
const ARCHETYPE_WARMUP_MINUTES = Math.max(1, Math.floor(environment.ARCHETYPE_WARMUP_MINUTES ?? 1));

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

  /** Flattened keyword list from the raw query, used to bold abstract matches. */
  readonly searchKeywords = computed(() => parseQuery(this.rawQuery()));

  // ── Scholar mode: server-side pagination (only the current page is held) ──────
  /** Exact total number of papers matching the query + filters (server-reported). */
  readonly scholarTotal = signal(0);
  /** Total matches for the query with NO user filters applied — the stable "papers
   *  found" figure. Captured on the unfiltered fetch and left untouched by filter
   *  refetches, so it only changes when the query itself changes. */
  readonly scholarUnfilteredTotal = signal(0);
  /** Whether another page is reachable within the navigable window. */
  readonly scholarHasMore = signal(false);
  /** Max number of results reachable via paging (server safety/window cap). */
  readonly scholarResultCap = signal(0);
  /** Pages the pagination bar may offer = matches clamped to the navigable window. */
  readonly scholarNavigableTotal = computed(() =>
    Math.min(this.scholarTotal(), this.scholarResultCap() || this.scholarTotal()),
  );
  /** Databases the user has selected to include in the results (all by default). */
  readonly selectedSources = signal<Set<string>>(new Set(ALL_SOURCES));
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
  /** Maximum number of seed papers that may be placed on the OK-Graph at once.
   *  Configurable via `SEED_LIMIT` in the environment/.env (default 3). */
  readonly seedLimit = Math.max(1, environment.SEED_LIMIT ?? 3);
  /** How many seed papers are currently on the graph. */
  readonly seedCount = computed(() => this.graphPaperIds().size);
  /** Whether another seed paper can still be added without exceeding the limit. */
  readonly canAddSeed = computed(() => this.seedCount() < this.seedLimit);
  /** Papers placed on the graph from outside the search results (e.g. cit-graph
   *  cluster representatives), keyed by paperId. Rendered by the graph view in
   *  addition to scored search results, without entering the results list. */
  readonly externalGraphPapers = signal<Map<string, Paper>>(new Map());
  graphInitialized = false;

  readonly sortField = signal<SortField>('relevancy');
  readonly selectedArchetypes = signal<Set<string>>(new Set(ALL_ARCHETYPES));

  /** Fields of study the user has selected to include (all by default). Like the archetype
   *  filter this is applied server-side in Scholar mode (across the whole match set) and
   *  client-side in the deprecated live/demo modes — see {@link serverSideArchetypeFilter}. */
  readonly selectedFields = signal<Set<string>>(new Set(ALL_SELECTABLE_FIELDS));

  /** Field-of-study counts across the whole filtered match set (from the backend facet
   *  aggregation), plus the no-field (Miscellaneous) count and the total. Populated per
   *  Scholar search/filter change so the dropdown shows real counts rather than page-only
   *  ones. Empty before the first facet response. */
  readonly fieldFacets = signal<{
    fields: Record<string, number>;
    miscellaneous: number;
    total: number;
    year_min: number | null;
    year_max: number | null;
  }>({
    fields: {},
    miscellaneous: 0,
    total: 0,
    year_min: null,
    year_max: null,
  });

  /** Scholar mode: the backend filters by archetype across the whole match set (resolved
   *  from the live classification cache), so the client-side archetype filter below is
   *  skipped — otherwise its secondary-AND semantics would wrongly drop papers the server
   *  already included. Live/demo modes keep filtering archetypes client-side. */
  readonly serverSideArchetypeFilter = signal(false);

  /** Scholar mode: cumulative archetype counts streamed from the backend classifier,
   *  built batch-by-batch in descending ok-score order across the whole match set.
   *  Drives the distribution panel in Scholar mode (loaded papers are only one page,
   *  so the panel can't be computed client-side there). Empty until the stream runs. */
  readonly scholarArchetypeCounts = signal<Record<string, number>>({});

  /** Per-paper archetypes streamed by the classifier, keyed by {@link paperId}, accumulated
   *  across the WHOLE match set (not just the loaded window). Overlaid onto papers in
   *  {@link scoredPapers}, so a page fetched later (e.g. navigating to page 11 and back)
   *  shows its already-computed archetypes without re-classifying. Reset per new search. */
  readonly archetypesById = signal<Record<string, [string | null, string | null]>>({});

  /** Scholar mode: progress of the ok-score-ordered archetype classification stream.
   *  `running` from the moment a search kicks off the stream until the backend has
   *  classified every retrieved paper (or the stream errors out); drives the
   *  "classifying…" template + progress indicator on the distribution panel. */
  readonly scholarClassifyProgress = signal<ScholarClassifyProgress>({
    status: 'idle',
    classified: 0,
    total: 0,
  });

  /** Scholar mode: true while the first archetype batch is overdue — the on-demand
   *  classifier (a separate Cloud Run scale-to-zero service) is likely cold-starting.
   *  Drives the "warming up" notice. Independent of the summarization model's warm-up
   *  ({@link ClusterSummaryService.warmingUp}); either service can be cold on its own.
   *  Armed/cleared by {@link ResultsComponent} around the classify stream. */
  readonly scholarClassifyWarmingUp = signal(false);

  /** User-facing copy for the archetype-classifier cold-start notice. Mirrors the
   *  summaries notice but for the classifier (load estimate is env-configurable). */
  readonly archetypeColdStartNotice =
    `Please be patient. For this alpha version, the archetype classification model ` +
    `runs on-demand and spins down when it's been idle for a while. If it has gone to ` +
    `sleep, it needs about ${ARCHETYPE_WARMUP_MINUTES} minute` +
    `${ARCHETYPE_WARMUP_MINUTES === 1 ? '' : 's'} to load before archetypes start ` +
    `streaming.`;
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

  /** Sticky widest range observed during the current search session. The slider
   *  bounds must NOT shrink when a filter narrows the result set — in Scholar mode a
   *  year/citation filter triggers a server-side refetch that returns only papers
   *  inside the selected range, so deriving the bounds straight from the loaded papers
   *  would collapse the slider onto the current selection and make it impossible to
   *  widen the range again. These accumulate the widest span seen and are reset on a
   *  new search ({@link resetForNewSearch}). */
  private readonly observedYearRange = signal<{ min: number; max: number } | null>(null);
  private readonly observedCitationMax = signal<number | null>(null);

  constructor() {
    // Widen the sticky slider bounds as papers load; never shrink them, so a filter
    // that narrows the (possibly server-refetched) result set can always be relaxed.
    effect(() => {
      const papers = this.scoredPapers();
      let yMin = Infinity, yMax = -Infinity, cMax = 0;
      for (const p of papers) {
        if (p.year != null) {
          if (p.year < yMin) yMin = p.year;
          if (p.year > yMax) yMax = p.year;
        }
        const c = p.citation_count ?? 0;
        if (c > cMax) cMax = c;
      }
      if (yMin <= yMax) {
        this.observedYearRange.update(prev =>
          prev
            ? { min: Math.min(prev.min, yMin), max: Math.max(prev.max, yMax) }
            : { min: yMin, max: yMax },
        );
      }
      if (papers.length > 0) {
        this.observedCitationMax.update(prev => (prev == null ? cMax : Math.max(prev, cMax)));
      }
    });

    // In Scholar mode the loaded papers are only the top ~100 of the match set, so the
    // page-derived bounds above undercount the true year span. The /facets aggregation
    // reports year_min/year_max across the WHOLE match set — widen the sticky range with
    // them. Like the page effect this only ever widens, so a year-narrowing refetch (whose
    // facets report a smaller span) can't collapse the slider.
    effect(() => {
      const { year_min, year_max } = this.fieldFacets();
      if (year_min == null || year_max == null || year_min > year_max) return;
      this.observedYearRange.update(prev =>
        prev
          ? { min: Math.min(prev.min, year_min), max: Math.max(prev.max, year_max) }
          : { min: year_min, max: year_max },
      );
    });
  }

  /** Sticky range bounds, used to populate slider min/max. See {@link observedYearRange}. */
  readonly yearRange = computed(() => this.observedYearRange() ?? { min: 2000, max: 2026 });

  readonly citationRange = computed(() => {
    const max = this.observedCitationMax();
    return { min: 0, max: max && max > 0 ? max : 100 };
  });

  /** Papers with scores attached (before filtering/sorting). */
  private readonly scoredPapers = computed(() => {
    const selected = this.selectedSources();
    let papers = this.dedupResult().papers;
    if (selected.size < ALL_SOURCES.length) {
      papers = papers.filter(p => (p.sources ?? []).some(s => selected.has(s)));
    }
    const scores = this.scoresByTitle();
    const archetypes = this.archetypesById();
    const w = SearchStateService.DEFAULT_WEIGHTS;
    return papers.map(p => {
      const key = p.title.toLowerCase();
      const backendScore = scores[key];
      const score = backendScore ?? computeOkScore(p, w);
      // Overlay any streamed archetype for this paper. This is what lets a window fetched
      // after classification (e.g. paging to 11 then back to 10) regain its archetypes:
      // the page's papers come back bare, but the streamed map persists and re-applies here.
      const arch = archetypes[paperId(p)];
      const mainArch = arch ? (arch[0] ?? undefined) : p.predicted_main_archetype;
      const secondArch = arch ? (arch[1] ?? undefined) : p.predicted_second_tier_archetype;
      const scoreChanged = p.ok_score !== score;
      const archChanged = !!arch
        && (p.predicted_main_archetype !== mainArch || p.predicted_second_tier_archetype !== secondArch);
      if (scoreChanged || archChanged) {
        return { ...p, ok_score: score, predicted_main_archetype: mainArch, predicted_second_tier_archetype: secondArch };
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
    const selectedArchs = this.selectedArchetypes();
    const selectedFields = this.selectedFields();
    // An empty archetype/field selection means "match nothing". The server treats an
    // empty filter list as "no filter" (returns everything), so enforce the zero-result
    // outcome here regardless of mode — otherwise deselecting all would show all papers.
    if (selectedArchs.size === 0 || selectedFields.size === 0) {
      return [];
    }
    // Scholar mode filters archetypes AND fields of study server-side across the whole match
    // set; skip the client-side passes so they don't second-guess the already-filtered page.
    const archetypeFilterClientSide = !this.serverSideArchetypeFilter();
    const fieldFilterClientSide = archetypeFilterClientSide
      && selectedFields.size < ALL_SELECTABLE_FIELDS.length;

    let result = papers.filter(p => {
      if (f.yearMin != null && (p.year == null || p.year < f.yearMin)) return false;
      if (f.yearMax != null && (p.year == null || p.year > f.yearMax)) return false;
      if (f.citationMin != null && (p.citation_count ?? 0) < f.citationMin) return false;
      if (f.citationMax != null && (p.citation_count ?? 0) > f.citationMax) return false;
      if (f.codeOnly && !p.has_public_code && !p.code_url) return false;
      if (f.peerReviewedOnly && !p.is_peer_reviewed) return false;
      if (f.openAccessOnly && !p.is_open_access) return false;

      // Filter out if the paper has a main or second-tier archetype that is NOT selected.
      // If it doesn't have an archetype (null, undefined, 'None'), it shouldn't be filtered out.
      if (archetypeFilterClientSide) {
        if (p.predicted_main_archetype && p.predicted_main_archetype !== 'None' && !selectedArchs.has(p.predicted_main_archetype)) {
          return false;
        }
        if (p.predicted_second_tier_archetype && p.predicted_second_tier_archetype !== 'None' && !selectedArchs.has(p.predicted_second_tier_archetype)) {
          return false;
        }
      }

      // Field-of-study filter. A paper with no fields belongs to the synthetic
      // "Miscellaneous" bucket, so it's kept only when Miscellaneous is selected; a paper
      // with fields is kept when any of its fields is selected. This mirrors the server-side
      // Scholar filter so both modes behave the same.
      if (fieldFilterClientSide) {
        const fields = p.fields_of_study ?? [];
        const matched = fields.length > 0
          ? fields.some(f => selectedFields.has(f))
          : selectedFields.has(MISC_FIELD);
        if (!matched) return false;
      }
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

  /** Whether the graph view has anything to render. True when a search has been
   *  run, or when papers were placed onto the graph directly (e.g. cit-graph
   *  cluster representatives), so the graph works without a prior search. */
  readonly hasGraphContent = computed(
    () => this.hasSearched() || this.externalGraphPapers().size > 0,
  );

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

  /** Add a paper as a seed. Returns false (without adding) when already present or
   *  when the seed limit would be exceeded, so callers can surface a notice. */
  addToGraph(paper: Paper): boolean {
    const id = paperId(paper);
    if (this.graphPaperIds().has(id)) return false;
    if (this.graphPaperIds().size >= this.seedLimit) return false;
    this.graphPaperIds.update(prev => new Set([...prev, id]));
    return true;
  }

  removeFromGraph(id: string): void {
    this.graphPaperIds.update(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Add papers that are not part of the search results onto the graph, respecting
   *  the seed limit. Papers already present don't count against new capacity.
   *  Returns the number actually added (0 if the limit was already reached). */
  addExternalGraphPapers(papers: Paper[]): number {
    if (!papers.length) return 0;
    const existing = this.graphPaperIds();
    let remaining = this.seedLimit - existing.size;
    const toAdd: Paper[] = [];
    for (const p of papers) {
      const id = paperId(p);
      if (existing.has(id)) continue;   // already a seed — doesn't consume capacity
      if (remaining <= 0) break;
      toAdd.push(p);
      remaining--;
    }
    if (!toAdd.length) return 0;
    this.externalGraphPapers.update(prev => {
      const next = new Map(prev);
      for (const p of toAdd) next.set(paperId(p), p);
      return next;
    });
    this.graphPaperIds.update(prev => {
      const next = new Set(prev);
      for (const p of toAdd) next.add(paperId(p));
      return next;
    });
    return toAdd.length;
  }

  /** Remove every node from the graph view. */
  flushGraph(): void {
    this.graphPaperIds.set(new Set());
    this.externalGraphPapers.set(new Map());
    // Keep the auto top-5 effect from immediately repopulating the graph.
    this.graphInitialized = true;
  }

  /**
   * Record archetypes produced by the backend classifier, keyed by the same identity as
   * paperId(). They accumulate into {@link archetypesById} (rather than mutating the loaded
   * page) so they survive a window refetch and are overlaid onto papers in
   * {@link scoredPapers} — including pages fetched after classification ran.
   */
  applyArchetypes(map: Record<string, [string | null, string | null]>): void {
    if (!map || Object.keys(map).length === 0) return;
    this.archetypesById.update(prev => ({ ...prev, ...map }));
  }

  /** Toggle a single database in/out of the selected set. */
  toggleSource(name: string): void {
    this.selectedSources.update(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    this.currentPage.set(1);
  }

  /** Select or clear every database at once. */
  setAllSources(selected: boolean): void {
    this.selectedSources.set(selected ? new Set(ALL_SOURCES) : new Set());
    this.currentPage.set(1);
  }

  /** Toggle a single archetype in/out of the selected set. */
  toggleArchetype(name: string): void {
    this.selectedArchetypes.update(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    this.currentPage.set(1);
  }

  /** Select or clear every archetype at once. */
  setAllArchetypes(selected: boolean): void {
    this.selectedArchetypes.set(selected ? new Set(ALL_ARCHETYPES) : new Set());
    this.currentPage.set(1);
  }

  /** Toggle a single field of study in/out of the selected set. */
  toggleField(name: string): void {
    this.selectedFields.update(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    this.currentPage.set(1);
  }

  /** Select or clear every field of study at once (Miscellaneous included). */
  setAllFields(selected: boolean): void {
    this.selectedFields.set(selected ? new Set(ALL_SELECTABLE_FIELDS) : new Set());
    this.currentPage.set(1);
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
    this.selectedSources.set(new Set(ALL_SOURCES));
    this.selectedArchetypes.set(new Set(ALL_ARCHETYPES));
    this.selectedFields.set(new Set(ALL_SELECTABLE_FIELDS));
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
    this.scholarTotal.set(0);
    this.scholarUnfilteredTotal.set(0);
    this.scholarHasMore.set(false);
    this.scholarResultCap.set(0);
    this.scholarArchetypeCounts.set({});
    this.archetypesById.set({});
    this.scholarClassifyProgress.set({ status: 'idle', classified: 0, total: 0 });
    this.scholarClassifyWarmingUp.set(false);
    this.fieldFacets.set({ fields: {}, miscellaneous: 0, total: 0, year_min: null, year_max: null });
    this.serverSideArchetypeFilter.set(false);
    this.graphPaperIds.set(new Set());
    this.externalGraphPapers.set(new Map());
    this.graphInitialized = false;
    this.observedYearRange.set(null);
    this.observedCitationMax.set(null);
    this.resetFilters();
  }
}
