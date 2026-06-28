import { Component, EventEmitter, Output, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphFilterService } from '../../../core/services/graph-filter.service';
import {
  SearchStateService,
  ALL_ARCHETYPES,
  ALL_FIELDS_OF_STUDY,
  ALL_SELECTABLE_FIELDS,
  MISC_FIELD,
} from '../../../core/services/search-state.service';

/**
 * Modal popup for the OK-Graph metadata filter. Mirrors the controls of the
 * Retrieved-Results filter sidebar (year, citations, code/peer-reviewed/open-access,
 * archetypes, fields of study) but is bound to the independent {@link GraphFilterService}
 * — never to the Results-tab filter state. Sort and Databases are intentionally
 * omitted (irrelevant to graph building).
 */
@Component({
  selector: 'app-graph-filters-popup',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './graph-filters-popup.component.html',
  styleUrl: './graph-filters-popup.component.scss',
})
export class GraphFiltersPopupComponent {
  readonly graphFilter = inject(GraphFilterService);
  private readonly search = inject(SearchStateService);

  @Output() readonly closed = new EventEmitter<void>();

  readonly archetypes = ALL_ARCHETYPES;
  readonly miscField = MISC_FIELD;

  archetypesOpen = false;
  fieldsOpen = false;

  close(): void {
    this.archetypesOpen = false;
    this.fieldsOpen = false;
    this.closed.emit();
  }

  reset(): void {
    this.graphFilter.resetMetadata();
  }

  // ── Year mode (around seed papers vs custom range) ────────────────────────────
  get yearMode(): 'context' | 'range' { return this.graphFilter.yearMode(); }
  setYearMode(mode: 'context' | 'range'): void { this.graphFilter.yearMode.set(mode); }

  readonly yearContext = computed(() => this.graphFilter.yearContext());

  /** The context windows rendered as text, e.g. "1988–1992, 2008–2012". */
  get contextIntervalsLabel(): string {
    const ints = this.yearContext().intervals;
    if (!ints.length) return '—';
    return ints.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(', ');
  }

  /** One-line description of the rule producing the current windows. */
  get contextRule(): string {
    const ctx = this.yearContext();
    if (ctx.mode === 'all') return 'Full span of all retrieved papers';
    if (ctx.seedCount === 0) return 'No seed papers selected yet';
    if (ctx.seedCount === 1) return 'Single seed paper ± 3 years';
    return `${ctx.seedCount} seed papers, each ± 2 years`;
  }

  /** True only when the context actually narrows the build (seed config). In 'all'
   *  config it reports the span but applies no filtering. */
  get contextNarrows(): boolean {
    const ctx = this.yearContext();
    return ctx.mode === 'seed' && ctx.intervals.length > 0;
  }

  // ── Year range ────────────────────────────────────────────────────────────────
  readonly yearBounds = computed(() => this.search.yearRange());

  get yearMin(): number {
    return this.graphFilter.metadata().yearMin ?? this.yearBounds().min;
  }
  set yearMin(val: number) {
    const clamped = Math.min(val, this.yearMax);
    this.graphFilter.updateMetadata({ yearMin: clamped <= this.yearBounds().min ? null : clamped });
  }

  get yearMax(): number {
    return this.graphFilter.metadata().yearMax ?? this.yearBounds().max;
  }
  set yearMax(val: number) {
    const clamped = Math.max(val, this.yearMin);
    this.graphFilter.updateMetadata({ yearMax: clamped >= this.yearBounds().max ? null : clamped });
  }

  get yearFill(): { left: number; right: number } {
    const r = this.yearBounds();
    const span = r.max - r.min || 1;
    return { left: ((this.yearMin - r.min) / span) * 100, right: ((r.max - this.yearMax) / span) * 100 };
  }

  // ── Citation range ─────────────────────────────────────────────────────────────
  readonly citationBounds = computed(() => this.search.citationRange());

  get citationMin(): number {
    return this.graphFilter.metadata().citationMin ?? 0;
  }
  set citationMin(val: number) {
    const clamped = Math.min(val, this.citationMax);
    this.graphFilter.updateMetadata({ citationMin: clamped <= 0 ? null : clamped });
  }

  get citationMax(): number {
    return this.graphFilter.metadata().citationMax ?? this.citationBounds().max;
  }
  set citationMax(val: number) {
    const clamped = Math.max(val, this.citationMin);
    this.graphFilter.updateMetadata({ citationMax: clamped >= this.citationBounds().max ? null : clamped });
  }

  get citationFill(): { left: number; right: number } {
    const max = this.citationBounds().max;
    const span = max || 1;
    return { left: (this.citationMin / span) * 100, right: ((max - this.citationMax) / span) * 100 };
  }

  // ── Toggles ──────────────────────────────────────────────────────────────────
  get codeOnly(): boolean { return this.graphFilter.metadata().codeOnly; }
  set codeOnly(v: boolean) { this.graphFilter.updateMetadata({ codeOnly: v }); }

  get peerReviewedOnly(): boolean { return this.graphFilter.metadata().peerReviewedOnly; }
  set peerReviewedOnly(v: boolean) { this.graphFilter.updateMetadata({ peerReviewedOnly: v }); }

  get openAccessOnly(): boolean { return this.graphFilter.metadata().openAccessOnly; }
  set openAccessOnly(v: boolean) { this.graphFilter.updateMetadata({ openAccessOnly: v }); }

  // ── Archetypes ──────────────────────────────────────────────────────────────
  toggleArchetypesMenu(): void { this.archetypesOpen = !this.archetypesOpen; }
  get allArchetypesSelected(): boolean {
    return this.graphFilter.metadata().archetypes.size === ALL_ARCHETYPES.length;
  }
  isArchetypeSelected(name: string): boolean {
    return this.graphFilter.metadata().archetypes.has(name);
  }
  toggleArchetype(name: string): void { this.graphFilter.toggleArchetype(name); }
  toggleAllArchetypes(event: Event): void {
    this.graphFilter.setAllArchetypes((event.target as HTMLInputElement).checked);
  }
  get archetypesSummary(): string {
    const count = this.graphFilter.metadata().archetypes.size;
    if (count === ALL_ARCHETYPES.length) return 'All archetypes';
    if (count === 0) return 'No archetypes';
    return `${count} of ${ALL_ARCHETYPES.length} archetypes`;
  }
  getArchetypePaperCount(arch: string): number {
    return this.search.allScoredPapers().filter(
      p => p.predicted_main_archetype === arch || p.predicted_second_tier_archetype === arch,
    ).length;
  }

  // ── Fields of study ─────────────────────────────────────────────────────────
  readonly visibleFields = ALL_FIELDS_OF_STUDY;
  toggleFieldsMenu(): void { this.fieldsOpen = !this.fieldsOpen; }
  get allFieldsSelected(): boolean {
    return this.graphFilter.metadata().fields.size === ALL_SELECTABLE_FIELDS.length;
  }
  isFieldSelected(name: string): boolean {
    return this.graphFilter.metadata().fields.has(name);
  }
  toggleField(name: string): void { this.graphFilter.toggleField(name); }
  toggleAllFields(event: Event): void {
    this.graphFilter.setAllFields((event.target as HTMLInputElement).checked);
  }
  get fieldsSummary(): string {
    const count = this.graphFilter.metadata().fields.size;
    if (count === ALL_SELECTABLE_FIELDS.length) return 'All fields';
    if (count === 0) return 'No fields';
    return `${count} of ${ALL_SELECTABLE_FIELDS.length} fields`;
  }
  getFieldPaperCount(field: string): number {
    return this.search.allScoredPapers().filter(p => (p.fields_of_study ?? []).includes(field)).length;
  }
  get miscFieldCount(): number {
    return this.search.allScoredPapers().filter(p => !(p.fields_of_study ?? []).length).length;
  }
}
