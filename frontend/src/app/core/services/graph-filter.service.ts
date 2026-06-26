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

  updateMetadata(partial: Partial<GraphMetadataFilter>): void {
    this.metadataUserEdited = true;
    this.metadata.update(m => ({ ...m, ...partial }));
  }

  /** Reset the graph filter: discard the user's sticky edits and re-arm the mirror,
   *  re-syncing to the current Retrieved-Results filter state. */
  resetMetadata(): void {
    this.metadataUserEdited = false;
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
    if (!this.metadataFilterActive()) return null;
    const m = this.metadata();
    const fields = m.fields.size < ALL_SELECTABLE_FIELDS.length ? [...m.fields] : [];
    const hasAny = m.yearMin != null || m.yearMax != null
      || m.citationMin != null || m.citationMax != null
      || m.openAccessOnly || fields.length > 0;
    if (!hasAny) return null;
    return {
      year_min: m.yearMin,
      year_max: m.yearMax,
      citation_min: m.citationMin,
      citation_max: m.citationMax,
      open_access_only: m.openAccessOnly,
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
    const metaActive = this.metadataFilterActive();
    const m = this.metadata();

    return (n: NodeLike): boolean => {
      if (keywordPred && !keywordPred(n)) return false;
      if (!metaActive) return true;
      return metadataNodeMatches(m, n, seedScope);
    };
  }
}
