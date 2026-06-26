import { Component, EventEmitter, Output, inject, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphPostFilterService } from '../../../core/services/graph-post-filter.service';
import { OkGraphStateService } from '../../../core/services/okgraph-state.service';
import {
  ALL_ARCHETYPES,
  ALL_FIELDS_OF_STUDY,
  ALL_SELECTABLE_FIELDS,
  MISC_FIELD,
} from '../../../core/services/search-state.service';

/**
 * Left-sliding panel for the OK-Graph's post-construction (in-graph) metadata filter.
 * Mirrors the build-time metadata popup's controls (year, citations, code / peer-reviewed
 * / open-access, archetypes, fields of study) but is bound to {@link GraphPostFilterService}
 * — so it only hides the visibility of non-matching nodes already on the graph, and is
 * fully reverted by Reset. Counts and slider bounds are derived from the graph's OWN nodes
 * (not the Retrieved-Results set).
 */
@Component({
  selector: 'app-in-graph-filter-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './in-graph-filter-panel.component.html',
  styleUrl: './in-graph-filter-panel.component.scss',
})
export class InGraphFilterPanelComponent {
  readonly postFilter = inject(GraphPostFilterService);
  private readonly state = inject(OkGraphStateService);

  @Output() readonly closed = new EventEmitter<void>();

  readonly archetypes = ALL_ARCHETYPES;
  readonly miscField = MISC_FIELD;
  readonly visibleFields = ALL_FIELDS_OF_STUDY;

  archetypesOpen = false;
  fieldsOpen = false;

  /** Year/citation extents over the graph's base nodes (drives the slider bounds). */
  readonly bounds = computed(() => {
    const nodes = this.state.nodes();
    let yMin = Infinity, yMax = -Infinity, cMax = 0;
    for (const n of nodes) {
      if (n.year != null) { yMin = Math.min(yMin, n.year); yMax = Math.max(yMax, n.year); }
      cMax = Math.max(cMax, n.citation_count ?? 0);
    }
    if (!Number.isFinite(yMin)) { yMin = 1900; yMax = new Date().getFullYear(); }
    return { yearMin: yMin, yearMax: yMax, citationMax: cMax };
  });

  close(): void {
    this.archetypesOpen = false;
    this.fieldsOpen = false;
    this.closed.emit();
  }

  reset(): void {
    this.postFilter.resetMetadata();
  }

  // ── Year range ────────────────────────────────────────────────────────────────
  get yearMin(): number {
    return this.postFilter.metadata().yearMin ?? this.bounds().yearMin;
  }
  set yearMin(val: number) {
    const clamped = Math.min(val, this.yearMax);
    this.postFilter.updateMetadata({ yearMin: clamped <= this.bounds().yearMin ? null : clamped });
  }

  get yearMax(): number {
    return this.postFilter.metadata().yearMax ?? this.bounds().yearMax;
  }
  set yearMax(val: number) {
    const clamped = Math.max(val, this.yearMin);
    this.postFilter.updateMetadata({ yearMax: clamped >= this.bounds().yearMax ? null : clamped });
  }

  get yearFill(): { left: number; right: number } {
    const b = this.bounds();
    const span = b.yearMax - b.yearMin || 1;
    return { left: ((this.yearMin - b.yearMin) / span) * 100, right: ((b.yearMax - this.yearMax) / span) * 100 };
  }

  // ── Citation range ─────────────────────────────────────────────────────────────
  get citationMin(): number {
    return this.postFilter.metadata().citationMin ?? 0;
  }
  set citationMin(val: number) {
    const clamped = Math.min(val, this.citationMax);
    this.postFilter.updateMetadata({ citationMin: clamped <= 0 ? null : clamped });
  }

  get citationMax(): number {
    return this.postFilter.metadata().citationMax ?? this.bounds().citationMax;
  }
  set citationMax(val: number) {
    const clamped = Math.max(val, this.citationMin);
    this.postFilter.updateMetadata({ citationMax: clamped >= this.bounds().citationMax ? null : clamped });
  }

  get citationFill(): { left: number; right: number } {
    const max = this.bounds().citationMax;
    const span = max || 1;
    return { left: (this.citationMin / span) * 100, right: ((max - this.citationMax) / span) * 100 };
  }

  // ── Toggles ──────────────────────────────────────────────────────────────────
  get codeOnly(): boolean { return this.postFilter.metadata().codeOnly; }
  set codeOnly(v: boolean) { this.postFilter.updateMetadata({ codeOnly: v }); }

  get peerReviewedOnly(): boolean { return this.postFilter.metadata().peerReviewedOnly; }
  set peerReviewedOnly(v: boolean) { this.postFilter.updateMetadata({ peerReviewedOnly: v }); }

  get openAccessOnly(): boolean { return this.postFilter.metadata().openAccessOnly; }
  set openAccessOnly(v: boolean) { this.postFilter.updateMetadata({ openAccessOnly: v }); }

  // ── Archetypes ──────────────────────────────────────────────────────────────
  toggleArchetypesMenu(): void { this.archetypesOpen = !this.archetypesOpen; }
  get allArchetypesSelected(): boolean {
    return this.postFilter.metadata().archetypes.size === ALL_ARCHETYPES.length;
  }
  isArchetypeSelected(name: string): boolean {
    return this.postFilter.metadata().archetypes.has(name);
  }
  toggleArchetype(name: string): void { this.postFilter.toggleArchetype(name); }
  toggleAllArchetypes(event: Event): void {
    this.postFilter.setAllArchetypes((event.target as HTMLInputElement).checked);
  }
  get archetypesSummary(): string {
    const count = this.postFilter.metadata().archetypes.size;
    if (count === ALL_ARCHETYPES.length) return 'All archetypes';
    if (count === 0) return 'No archetypes';
    return `${count} of ${ALL_ARCHETYPES.length} archetypes`;
  }
  getArchetypePaperCount(arch: string): number {
    return this.state.nodes().filter(
      n => n.predicted_main_archetype === arch || n.predicted_second_tier_archetype === arch,
    ).length;
  }

  // ── Fields of study ─────────────────────────────────────────────────────────
  toggleFieldsMenu(): void { this.fieldsOpen = !this.fieldsOpen; }
  get allFieldsSelected(): boolean {
    return this.postFilter.metadata().fields.size === ALL_SELECTABLE_FIELDS.length;
  }
  isFieldSelected(name: string): boolean {
    return this.postFilter.metadata().fields.has(name);
  }
  toggleField(name: string): void { this.postFilter.toggleField(name); }
  toggleAllFields(event: Event): void {
    this.postFilter.setAllFields((event.target as HTMLInputElement).checked);
  }
  get fieldsSummary(): string {
    const count = this.postFilter.metadata().fields.size;
    if (count === ALL_SELECTABLE_FIELDS.length) return 'All fields';
    if (count === 0) return 'No fields';
    return `${count} of ${ALL_SELECTABLE_FIELDS.length} fields`;
  }
  getFieldPaperCount(field: string): number {
    return this.state.nodes().filter(n => (n.fields_of_study ?? []).includes(field)).length;
  }
  get miscFieldCount(): number {
    return this.state.nodes().filter(n => !(n.fields_of_study ?? []).length).length;
  }
}
