import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { ALL_ARCHETYPES, ALL_SELECTABLE_FIELDS, MISC_FIELD, SearchStateService } from './search-state.service';
import { GraphNodeFilterPayload } from './citgraph.service';
import { compileNodePredicate } from '../../shared/utils/boolean-query';

/**
 * Metadata-filter state for OK-Graph building. Kept as a separate signal from the
 * Retrieved-Results `FilterState` / `selectedArchetypes` / `selectedFields`, but
 * one-directionally mirrored FROM them: setting a filter on the Results page is
 * reflected in this graph metadata (and therefore in the graph filter panel, which
 * binds directly to {@link metadata}). The reverse never happens — editing the graph
 * filter panel does not touch the Results view.
 *
 * Graph-panel edits are sticky: once the user touches the graph filter, their values
 * are held and subsequent Results changes no longer overwrite them, until they Reset
 * the graph filter (which re-arms the mirror). See the constructor effect and
 * {@link metadataUserEdited}.
 *
 * Defaults are a no-op: null ranges, all flags off, every archetype/field selected.
 */
export interface GraphMetadataFilter {
  yearMin: number | null;
  yearMax: number | null;
  citationMin: number | null;
  citationMax: number | null;
  codeOnly: boolean;
  peerReviewedOnly: boolean;
  openAccessOnly: boolean;
  archetypes: Set<string>; // size === ALL_ARCHETYPES.length ⇒ no archetype filter
  fields: Set<string>;     // size === ALL_SELECTABLE_FIELDS.length ⇒ no field filter
}

/** Shape a graph node / paper must (partially) satisfy to be tested by the filter. */
export interface NodeLike {
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  citation_count?: number | null;
  is_open_access?: boolean | null;
  fields_of_study?: string[] | null;
  has_public_code?: boolean | null;
  code_url?: string | null;
  is_peer_reviewed?: boolean | null;
  predicted_main_archetype?: string | null;
  predicted_second_tier_archetype?: string | null;
}

export function defaultMetadata(): GraphMetadataFilter {
  return {
    yearMin: null,
    yearMax: null,
    citationMin: null,
    citationMax: null,
    codeOnly: false,
    peerReviewedOnly: false,
    openAccessOnly: false,
    archetypes: new Set(ALL_ARCHETYPES),
    fields: new Set(ALL_SELECTABLE_FIELDS),
  };
}

/**
 * Pure test of a node against a {@link GraphMetadataFilter}. Year / citation /
 * open-access / field constraints are always enforced. Code / peer-reviewed /
 * archetype are only enforced when `seedScope` is true — expanded nodes (hydrated
 * from OpenSearch) lack that metadata and are passed through rather than dropped.
 *
 * Shared by the build-time filter ({@link GraphFilterService.nodePredicate}) and the
 * post-construction in-graph filter so both apply identical semantics.
 */
export function metadataNodeMatches(m: GraphMetadataFilter, n: NodeLike, seedScope: boolean): boolean {
  if (m.yearMin != null && (n.year == null || n.year < m.yearMin)) return false;
  if (m.yearMax != null && (n.year == null || n.year > m.yearMax)) return false;
  const cc = n.citation_count ?? 0;
  if (m.citationMin != null && cc < m.citationMin) return false;
  if (m.citationMax != null && cc > m.citationMax) return false;
  if (m.openAccessOnly && !n.is_open_access) return false;

  if (m.fields.size < ALL_SELECTABLE_FIELDS.length) {
    const fields = n.fields_of_study ?? [];
    const matched = fields.length > 0
      ? fields.some(f => m.fields.has(f))
      : m.fields.has(MISC_FIELD);
    if (!matched) return false;
  }

  // Code / peer-reviewed / archetype: only enforceable where full metadata
  // exists (seeds). Expanded nodes pass through.
  if (seedScope) {
    if (m.codeOnly && !n.has_public_code && !n.code_url) return false;
    if (m.peerReviewedOnly && !n.is_peer_reviewed) return false;
    if (m.archetypes.size < ALL_ARCHETYPES.length) {
      const main = n.predicted_main_archetype;
      if (main && main !== 'None' && !m.archetypes.has(main)) return false;
      const second = n.predicted_second_tier_archetype;
      if (second && second !== 'None' && !m.archetypes.has(second)) return false;
    }
  }
  return true;
}

/**
 * The auto-computed "around seed papers" year context for an OK-Graph build.
 * `mode` records which section-1 configuration produced it; `intervals` are the
 * resulting inclusive `[lo, hi]` windows. Seed windows narrow the build (seed ±3 for
 * a single seed, ±2 each for multiple — possibly disconnected, e.g. 1990 & 2010 →
 * `[[1988,1992],[2008,2012]]`). An `all` context reports the source set's span only
 * and narrows nothing.
 */
export interface YearContext {
  mode: 'seed' | 'all';
  seedCount: number;
  intervals: Array<[number, number]>;
}

/** Merge overlapping or adjacent intervals (gap ≤ 1, since years are integers, so
 *  `[…,1992]` and `[1993,…]` collapse — no integer sits between them). */
export function mergeYearIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals
    .filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi))
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

/** Seed-context windows: each valid year padded by ±`pad`, then merged. */
export function seedContextIntervals(
  years: Array<number | null | undefined>,
  pad: number,
): Array<[number, number]> {
  const valid = years.filter((y): y is number => y != null && Number.isFinite(y));
  if (!valid.length) return [];
  return mergeYearIntervals(valid.map(y => [y - pad, y + pad] as [number, number]));
}

/** Whether `year` lands in any inclusive interval (null fails, as with a single bound). */
export function yearInIntervals(
  year: number | null | undefined,
  intervals: Array<[number, number]>,
): boolean {
  if (year == null) return false;
  return intervals.some(([lo, hi]) => year >= lo && year <= hi);
}

/** Whether any constraint in `m` differs from the no-op default (i.e. it would hide
 *  at least some nodes). Shared by both the build-time and post-construction filters. */
export function hasActiveMetadataConstraint(m: GraphMetadataFilter): boolean {
  return m.yearMin != null || m.yearMax != null
    || m.citationMin != null || m.citationMax != null
    || m.codeOnly || m.peerReviewedOnly || m.openAccessOnly
    || m.archetypes.size < ALL_ARCHETYPES.length
    || m.fields.size < ALL_SELECTABLE_FIELDS.length;
}

@Injectable({ providedIn: 'root' })
export class GraphFilterService {
  private readonly search = inject(SearchStateService);

  constructor() {
    // One-directional mirror: Retrieved-Results filters → graph metadata panel.
    // Reads ONLY the Results filter signals (never `metadata`), so graph-side edits
    // never flow back to Results. The Results reads happen before the sticky gate so
    // the effect stays subscribed to them even while sticky — once the user edits the
    // graph panel ({@link metadataUserEdited}), their values stick and Results changes
    // no longer overwrite them, until they Reset the graph filter (re-arms the mirror).
    effect(() => {
      const snapshot = this.resultsSnapshot();
      if (this.metadataUserEdited) return;
      this.metadata.set(snapshot);
    });
  }

  /** Snapshot the current Retrieved-Results filter state as a {@link GraphMetadataFilter}.
   *  Fresh Sets are built so the two services never share a mutable reference. */
  private resultsSnapshot(): GraphMetadataFilter {
    const f = this.search.filters();
    return {
      yearMin: f.yearMin,
      yearMax: f.yearMax,
      citationMin: f.citationMin,
      citationMax: f.citationMax,
      codeOnly: f.codeOnly,
      peerReviewedOnly: f.peerReviewedOnly,
      openAccessOnly: f.openAccessOnly,
      archetypes: new Set(this.search.selectedArchetypes()),
      fields: new Set(this.search.selectedFields()),
    };
  }

  // ── Keyword (boolean query) filtering ───────────────────────────────────────
  /** Whether the boolean keyword filter is enabled (the Panel 2 "Keyword Filtering" toggle). */
  readonly keywordFilterActive = signal(false);
  /** The editable boolean query string (title + abstract). */
  readonly booleanQuery = signal('');
  /** True once the user has typed in the query field — stops search prefill clobbering it. */
  private userEdited = false;

  /** Set the query from a user edit (marks the field as user-owned). */
  setBooleanQuery(value: string): void {
    this.userEdited = true;
    this.booleanQuery.set(value);
  }

  /** Prefill the query with the latest search text, but only until the user edits it. */
  prefillBooleanQuery(raw: string): void {
    if (this.userEdited) return;
    this.booleanQuery.set(raw ?? '');
  }

  /** True when keyword filtering is on and the query is non-empty. */
  readonly keywordFilterEffective = computed(
    () => this.keywordFilterActive() && this.booleanQuery().trim().length > 0,
  );

  // ── Metadata filtering ────────────────────────────────────────────────────────
  /** Whether the metadata filter popup constraints are enabled. */
  readonly metadataFilterActive = signal(false);
  readonly metadata = signal<GraphMetadataFilter>(defaultMetadata());

  /** True once the user has edited the graph filter panel — makes their values sticky
   *  so the Results→graph mirror ({@link resultsSnapshot}) stops overwriting them.
   *  Cleared by {@link resetMetadata} to re-arm the mirror. */
  private metadataUserEdited = false;

  // ── Year mode: "around seed papers" (default) vs custom range ─────────────────
  /** Year-filter mode for the build. 'context' (the default) applies the auto
   *  seed-context windows ({@link yearContext}); 'range' uses the manual slider
   *  (metadata `yearMin`/`yearMax`). Lives next to the year control in the popup. */
  readonly yearMode = signal<'context' | 'range'>('context');

  /** The auto-computed year context, kept in sync by the OK-Graph component from the
   *  section-1 configuration (seed papers vs all retrieved). */
  private readonly autoYearContext = signal<YearContext>({ mode: 'seed', seedCount: 0, intervals: [] });
  setAutoYearContext(ctx: YearContext): void { this.autoYearContext.set(ctx); }
  readonly yearContext = computed(() => this.autoYearContext());

  /** The year windows that actually gate the build, or null for no auto-narrowing.
   *  Only 'context' mode with a 'seed' configuration narrows; an 'all' context is the
   *  full span of the source set (every paper is already inside it), so it returns null
   *  rather than dropping null-year papers. */
  effectiveContextIntervals(): Array<[number, number]> | null {
    if (this.yearMode() !== 'context') return null;
    const ctx = this.autoYearContext();
    if (ctx.mode !== 'seed' || !ctx.intervals.length) return null;
    return ctx.intervals;
  }

  /** True when the seed-context year windows are actively gating the build. */
  readonly yearContextActive = computed(() => this.effectiveContextIntervals() != null);

  updateMetadata(partial: Partial<GraphMetadataFilter>): void {
    this.metadataUserEdited = true;
    this.metadata.update(m => ({ ...m, ...partial }));
  }

  /** Reset the graph filter: discard the user's sticky edits and re-arm the mirror,
   *  re-syncing to the current Retrieved-Results filter state. */
  resetMetadata(): void {
    this.metadataUserEdited = false;
    this.yearMode.set('context');
    this.metadata.set(this.resultsSnapshot());
  }

  /** Clear everything back to a no-op filter (also re-enables search prefill). */
  resetAll(): void {
    this.keywordFilterActive.set(false);
    this.metadataFilterActive.set(false);
    this.userEdited = false;
    this.booleanQuery.set('');
    this.resetMetadata();
  }

  // Archetype helpers (mirror search-state semantics: selected subset).
  toggleArchetype(name: string): void {
    this.metadataUserEdited = true;
    this.metadata.update(m => {
      const next = new Set(m.archetypes);
      next.has(name) ? next.delete(name) : next.add(name);
      return { ...m, archetypes: next };
    });
  }

  setAllArchetypes(on: boolean): void {
    this.updateMetadata({ archetypes: on ? new Set(ALL_ARCHETYPES) : new Set() });
  }

  toggleField(name: string): void {
    this.metadataUserEdited = true;
    this.metadata.update(m => {
      const next = new Set(m.fields);
      next.has(name) ? next.delete(name) : next.add(name);
      return { ...m, fields: next };
    });
  }

  setAllFields(on: boolean): void {
    this.updateMetadata({ fields: on ? new Set(ALL_SELECTABLE_FIELDS) : new Set() });
  }

  /** Any metadata constraint differs from its no-op default. */
  readonly hasActiveMetadataFilter = computed(() => hasActiveMetadataConstraint(this.metadata()));

  /** Short label for the popup trigger chip. */
  readonly metadataSummary = computed(() => {
    if (!this.metadataFilterActive() || !this.hasActiveMetadataFilter()) return 'no constraints';
    const m = this.metadata();
    const parts: string[] = [];
    if (m.yearMin != null || m.yearMax != null) parts.push('year');
    if (m.citationMin != null || m.citationMax != null) parts.push('citations');
    if (m.openAccessOnly) parts.push('open access');
    if (m.codeOnly) parts.push('code');
    if (m.peerReviewedOnly) parts.push('peer-reviewed');
    if (m.fields.size < ALL_SELECTABLE_FIELDS.length) parts.push('fields');
    if (m.archetypes.size < ALL_ARCHETYPES.length) parts.push('archetypes');
    return parts.join(', ') || 'no constraints';
  });

  /** The boolean query to send to the backend (empty string ⇒ omit), reflecting
   *  whether keyword filtering is active and non-empty. */
  backendBooleanQuery(): string | null {
    return this.keywordFilterEffective() ? this.booleanQuery() : null;
  }

  /**
   * Backend payload for the enforceable-on-expansion metadata constraints
   * (year / citation / open-access / fields). Returns null when metadata filtering
   * is off or sets no enforceable constraint. Code / peer-reviewed / archetype are
   * deliberately excluded — they're pre-filtered on seeds client-side.
   */
  backendNodeFilter(): GraphNodeFilterPayload | null {
    // The seed-context year windows ("around seed papers" default) gate the build even
    // when the broader metadata filter is off — so this can return a filter carrying only
    // year_intervals. When set, the windows supersede the slider's single year bound.
    const intervals = this.effectiveContextIntervals();
    const metaActive = this.metadataFilterActive();
    const m = this.metadata();
    const fields = metaActive && m.fields.size < ALL_SELECTABLE_FIELDS.length ? [...m.fields] : [];
    const yearMin = intervals ? null : (metaActive ? m.yearMin : null);
    const yearMax = intervals ? null : (metaActive ? m.yearMax : null);
    const citationMin = metaActive ? m.citationMin : null;
    const citationMax = metaActive ? m.citationMax : null;
    const openAccessOnly = metaActive ? m.openAccessOnly : false;
    const hasAny = intervals != null
      || yearMin != null || yearMax != null
      || citationMin != null || citationMax != null
      || openAccessOnly || fields.length > 0;
    if (!hasAny) return null;
    return {
      year_min: yearMin,
      year_max: yearMax,
      year_intervals: intervals ? intervals.map(([lo, hi]) => [lo, hi]) : null,
      citation_min: citationMin,
      citation_max: citationMax,
      open_access_only: openAccessOnly,
      fields,
    };
  }

  /**
   * Build a predicate over a node's metadata for the CURRENTLY active filters.
   *
   * `seedScope=true` enforces every constraint (full metadata is known for seeds
   * / retrieved papers). `seedScope=false` (expanded nodes hydrated from
   * OpenSearch) passes through code / peer-reviewed / archetype, which aren't
   * available there — those nodes are never dropped for missing data.
   */
  nodePredicate(seedScope: boolean): (n: NodeLike) => boolean {
    const keywordPred = this.keywordFilterEffective()
      ? compileNodePredicate(this.booleanQuery())
      : null;
    const intervals = this.effectiveContextIntervals();
    const metaActive = this.metadataFilterActive();
    const m = this.metadata();

    return (n: NodeLike): boolean => {
      if (keywordPred && !keywordPred(n)) return false;
      if (intervals && !yearInIntervals(n.year, intervals)) return false;
      if (!metaActive) return true;
      return metadataNodeMatches(m, n, seedScope);
    };
  }
}
