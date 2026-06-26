import { Component, ElementRef, HostListener, inject, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ALL_SOURCES, SearchStateService, SortField, ALL_ARCHETYPES, ALL_FIELDS_OF_STUDY, ALL_SELECTABLE_FIELDS, MISC_FIELD } from '../../../core/services/search-state.service';
import { SearchModeService } from '../../../core/services/search-mode.service';

const ARCHETYPE_META: Record<string, { color: string; icon: string; gradient: string }> = {
  'The Innovator': { color: '#a855f7', icon: 'emoji_objects', gradient: 'linear-gradient(90deg, #a855f7, #c084fc)' },
  'The Evaluator': { color: '#0ea5e9', icon: 'fact_check', gradient: 'linear-gradient(90deg, #0ea5e9, #38bdf8)' },
  'The Combiner': { color: '#f59e0b', icon: 'layers', gradient: 'linear-gradient(90deg, #f59e0b, #fbbf24)' },
  'The Analyst': { color: '#ef4444', icon: 'analytics', gradient: 'linear-gradient(90deg, #ef4444, #f87171)' },
  'The Synthesizer': { color: '#3b82f6', icon: 'summarize', gradient: 'linear-gradient(90deg, #3b82f6, #60a5fa)' },
  'The Translator': { color: '#ec4899', icon: 'transform', gradient: 'linear-gradient(90deg, #ec4899, #f472b6)' },
  'The Architect': { color: '#10b981', icon: 'schema', gradient: 'linear-gradient(90deg, #10b981, #34d399)' },
  'The Resource Creator': { color: '#4f46e5', icon: 'storage', gradient: 'linear-gradient(90deg, #4f46e5, #818cf8)' },
};

@Component({
  selector: 'app-filters-sidebar',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './filters-sidebar.component.html',
  styleUrl: './filters-sidebar.component.scss',
})
export class FiltersSidebarComponent {
  readonly state = inject(SearchStateService);
  private readonly mode = inject(SearchModeService);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Scholar mode: code + per-database filters aren't yet filterable across the whole corpus
   *  (that field isn't backfilled / it's a single source), so they're hidden. Archetype
   *  filtering IS available — the backend resolves it from the live classification cache. */
  get isScholar(): boolean {
    return this.mode.isScholar();
  }

  /** Computed archetype distribution.
   *
   * In Scholar mode the client only holds one page, so counts come from the backend
   * classify stream ({@link SearchStateService.scholarArchetypeCounts}), which covers the
   * whole match set in descending ok-score order and grows batch by batch. In live/demo
   * mode the full result set is in memory, so we count the loaded scored papers directly.
   *
   * The panel reflects the archetype filter: only currently-selected archetypes are
   * counted, and percentages are recomputed over the selected-subset total — so filtering
   * archetypes updates the distribution accordingly. Deselected archetypes fall to 0% and
   * render greyed (and drop out of the bar, which only draws segments with percentage > 0).
   */
  readonly archetypeDistribution = computed(() => {
    const selected = this.state.selectedArchetypes();
    const counts = ALL_ARCHETYPES.reduce((acc, arch) => {
      acc[arch] = 0;
      return acc;
    }, {} as Record<string, number>);

    let totalClassified = 0;
    if (this.isScholar) {
      const streamed = this.state.scholarArchetypeCounts();
      for (const [arch, n] of Object.entries(streamed)) {
        if (arch in counts && selected.has(arch)) {
          counts[arch] += n;
          totalClassified += n;
        }
      }
    } else {
      for (const p of this.state.allScoredPapers()) {
        const arch = p.predicted_main_archetype;
        if (arch && arch !== 'None' && arch in counts && selected.has(arch)) {
          counts[arch]++;
          totalClassified++;
        }
      }
    }

    return ALL_ARCHETYPES.map(name => {
      const count = counts[name];
      const percentage = totalClassified > 0 ? Math.round((count / totalClassified) * 100) : 0;
      const meta = ARCHETYPE_META[name] || { color: '#6b7280', icon: 'layers', gradient: 'linear-gradient(90deg, #6b7280, #9ca3af)' };
      return {
        name,
        count,
        percentage,
        ...meta
      };
    }).sort((a, b) => b.count - a.count);
  });

  readonly hasClassifiedPapers = computed(() => {
    return this.archetypeDistribution().some(item => item.count > 0);
  });

  /** Whether classification produced any data at all, independent of the current
   *  archetype selection. Unlike {@link hasClassifiedPapers} (which counts only the
   *  selected subset), this stays true when the user deselects every archetype — so the
   *  panel remains visible showing an empty bar with all archetypes at 0%. */
  readonly hasAnyClassification = computed(() => {
    if (this.isScholar) {
      return Object.values(this.state.scholarArchetypeCounts()).some(n => n > 0);
    }
    return this.state.allScoredPapers().some(p => {
      const a = p.predicted_main_archetype;
      return !!a && a !== 'None';
    });
  });

  /** Whether the ok-score-ordered classification stream is still running (Scholar mode). */
  readonly isClassifying = computed(
    () => this.isScholar && this.state.scholarClassifyProgress().status === 'running',
  );

  /** Show the distribution card while classification is in progress (even before the
   *  first batch lands, as a template) or once any papers have been classified — even
   *  if the current selection is empty, so the panel never vanishes on full deselection. */
  readonly showDistributionPanel = computed(
    () => this.isClassifying() || this.hasAnyClassification(),
  );

  /** Progress of the classification stream, for the in-progress indicator. */
  readonly classifyProgress = computed(() => this.state.scholarClassifyProgress());

  /** Percentage of retrieved papers classified so far (0 until a total is known). */
  readonly classifyPercent = computed(() => {
    const { classified, total } = this.classifyProgress();
    return total > 0 ? Math.min(100, Math.round((classified / total) * 100)) : 0;
  });

  /** True before the first batch arrives — show skeleton placeholder rows. */
  readonly showSkeleton = computed(
    () => this.isClassifying() && !this.hasClassifiedPapers(),
  );

  /** Placeholder rows rendered while waiting for the first batch — one per
   *  archetype, so the panel keeps a constant height across the skeleton →
   *  loaded transition. */
  readonly skeletonRows = ALL_ARCHETYPES.map((_, i) => i);

  /** Whether the databases dropdown menu is open. */
  databasesOpen = false;

  /** Whether the archetypes dropdown menu is open. */
  archetypesOpen = false;

  /** Whether the fields-of-study dropdown menu is open. */
  fieldsOpen = false;

  get sortField(): SortField {
    return this.state.sortField();
  }

  set sortField(val: SortField) {
    this.state.sortField.set(val);
    this.state.currentPage.set(1);
  }

  get yearMin(): number {
    return this.state.filters().yearMin ?? this.state.yearRange().min;
  }

  set yearMin(val: number) {
    // Typed inputs can emit null/NaN (empty field) — ignore rather than corrupt
    // the filter; the getter then restores the displayed value to the boundary.
    if (val == null || Number.isNaN(val)) return;
    const range = this.state.yearRange();
    // Never let the lower knob cross above the upper knob (would invert the
    // range and crash the results list); clamp it to the current max instead.
    const clamped = Math.max(range.min, Math.min(val, this.yearMax));
    this.state.updateFilter({ yearMin: clamped <= range.min ? null : clamped });
  }

  get yearMax(): number {
    return this.state.filters().yearMax ?? this.state.yearRange().max;
  }

  set yearMax(val: number) {
    if (val == null || Number.isNaN(val)) return;
    const range = this.state.yearRange();
    // Never let the upper knob cross below the lower knob.
    const clamped = Math.min(range.max, Math.max(val, this.yearMin));
    this.state.updateFilter({ yearMax: clamped >= range.max ? null : clamped });
  }

  get citationMin(): number {
    return this.state.filters().citationMin ?? 0;
  }

  set citationMin(val: number) {
    if (val == null || Number.isNaN(val)) return;
    const clamped = Math.max(0, Math.min(val, this.citationMax));
    this.state.updateFilter({ citationMin: clamped <= 0 ? null : clamped });
  }

  get citationMax(): number {
    return this.state.filters().citationMax ?? this.state.citationRange().max;
  }

  set citationMax(val: number) {
    if (val == null || Number.isNaN(val)) return;
    const range = this.state.citationRange();
    const clamped = Math.min(range.max, Math.max(val, this.citationMin));
    this.state.updateFilter({ citationMax: clamped >= range.max ? null : clamped });
  }

  /** Inset percentages ({@link left}/{@link right}) for the highlighted track
   *  segment between the year knobs. */
  get yearFill(): { left: number; right: number } {
    const r = this.state.yearRange();
    const span = r.max - r.min || 1;
    return {
      left: ((this.yearMin - r.min) / span) * 100,
      right: ((r.max - this.yearMax) / span) * 100,
    };
  }

  /** Inset percentages for the highlighted track segment between the citation knobs. */
  get citationFill(): { left: number; right: number } {
    const max = this.state.citationRange().max;
    const span = max || 1;
    return {
      left: (this.citationMin / span) * 100,
      right: ((max - this.citationMax) / span) * 100,
    };
  }

  get codeOnly(): boolean {
    return this.state.filters().codeOnly;
  }

  set codeOnly(val: boolean) {
    this.state.updateFilter({ codeOnly: val });
  }

  get peerReviewedOnly(): boolean {
    return this.state.filters().peerReviewedOnly;
  }

  set peerReviewedOnly(val: boolean) {
    this.state.updateFilter({ peerReviewedOnly: val });
  }

  get openAccessOnly(): boolean {
    return this.state.filters().openAccessOnly;
  }

  set openAccessOnly(val: boolean) {
    this.state.updateFilter({ openAccessOnly: val });
  }

  readonly archetypes = ALL_ARCHETYPES;

  toggleArchetypesMenu(): void {
    this.archetypesOpen = !this.archetypesOpen;
  }

  get allArchetypesSelected(): boolean {
    return this.state.selectedArchetypes().size === ALL_ARCHETYPES.length;
  }

  isArchetypeSelected(name: string): boolean {
    return this.state.selectedArchetypes().has(name);
  }

  toggleArchetype(name: string): void {
    this.state.toggleArchetype(name);
  }

  toggleAllArchetypes(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setAllArchetypes(checked);
  }

  get archetypesSummary(): string {
    const count = this.state.selectedArchetypes().size;
    if (count === ALL_ARCHETYPES.length) return 'All archetypes';
    if (count === 0) return 'No archetypes';
    return `${count} of ${ALL_ARCHETYPES.length} archetypes`;
  }

  /** The synthetic "no field of study" bucket, exposed to the template. */
  readonly miscField = MISC_FIELD;

  /** Whether the backend facet counts have arrived (drives count source + which fields show). */
  private readonly hasFacets = computed(() => {
    const f = this.state.fieldFacets();
    return f.total > 0 || Object.keys(f.fields).length > 0;
  });

  /** Canonical fields to list: once facet counts exist, only those with ≥1 paper (so the
   *  dropdown isn't cluttered with empty fields); before then, the full canonical list. */
  readonly visibleFields = computed(() => {
    if (!this.hasFacets()) return [...ALL_FIELDS_OF_STUDY];
    const counts = this.state.fieldFacets().fields;
    return ALL_FIELDS_OF_STUDY.filter(name => (counts[name] ?? 0) > 0);
  });

  /** Number of retrieved papers with no field of study (the Miscellaneous bucket). */
  readonly miscFieldCount = computed(() => this.state.fieldFacets().miscellaneous);

  /** Show the Miscellaneous row only when some retrieved papers lack a field of study. */
  readonly showMiscField = computed(() => this.hasFacets() && this.miscFieldCount() > 0);

  toggleFieldsMenu(): void {
    this.fieldsOpen = !this.fieldsOpen;
  }

  get allFieldsSelected(): boolean {
    return this.state.selectedFields().size === ALL_SELECTABLE_FIELDS.length;
  }

  isFieldSelected(name: string): boolean {
    return this.state.selectedFields().has(name);
  }

  toggleField(name: string): void {
    this.state.toggleField(name);
  }

  toggleAllFields(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setAllFields(checked);
  }

  get fieldsSummary(): string {
    const count = this.state.selectedFields().size;
    if (count === ALL_SELECTABLE_FIELDS.length) return 'All fields';
    if (count === 0) return 'No fields';
    return `${count} of ${ALL_SELECTABLE_FIELDS.length} fields`;
  }

  /** Per-field paper count across the whole match set, from the backend facet aggregation.
   *  Falls back to counting the loaded page when facets haven't arrived (or in the
   *  deprecated demo/live modes, which hold the full set client-side anyway). */
  getFieldPaperCount(field: string): number {
    if (this.hasFacets()) return this.state.fieldFacets().fields[field] ?? 0;
    return this.state.allScoredPapers().filter(p =>
      (p.fields_of_study ?? []).includes(field)
    ).length;
  }

  getArchetypePaperCount(arch: string): number {
    // Scholar mode holds only one page client-side, so the count comes from the backend
    // classify stream, which spans the whole match set in descending ok-score order.
    if (this.isScholar) {
      return this.state.scholarArchetypeCounts()[arch] ?? 0;
    }
    return this.state.allScoredPapers().filter(p =>
      p.predicted_main_archetype === arch || p.predicted_second_tier_archetype === arch
    ).length;
  }

  /** Toggle the databases dropdown menu open/closed. */
  toggleDatabasesMenu(): void {
    this.databasesOpen = !this.databasesOpen;
  }

  /** Close the dropdown when clicking anywhere outside the sidebar. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.databasesOpen && !this.host.nativeElement.contains(event.target)) {
      this.databasesOpen = false;
    }
    if (this.archetypesOpen && !this.host.nativeElement.contains(event.target)) {
      this.archetypesOpen = false;
    }
    if (this.fieldsOpen && !this.host.nativeElement.contains(event.target)) {
      this.fieldsOpen = false;
    }
  }

  get allSourcesSelected(): boolean {
    return this.state.selectedSources().size === ALL_SOURCES.length;
  }

  isSourceSelected(name: string): boolean {
    return this.state.selectedSources().has(name);
  }

  toggleSource(name: string): void {
    this.state.toggleSource(name);
  }

  toggleAllSources(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.state.setAllSources(checked);
  }

  /** Short label summarising the current database selection. */
  get databasesSummary(): string {
    const count = this.state.selectedSources().size;
    if (count === ALL_SOURCES.length) return 'All databases';
    if (count === 0) return 'No databases';
    return `${count} of ${ALL_SOURCES.length} databases`;
  }

  get hasActiveFilters(): boolean {
    const f = this.state.filters();
    return f.yearMin != null || f.yearMax != null
      || f.citationMin != null || f.citationMax != null
      || f.codeOnly || f.peerReviewedOnly || f.openAccessOnly
      || this.state.selectedArchetypes().size < ALL_ARCHETYPES.length
      || this.state.selectedFields().size < ALL_SELECTABLE_FIELDS.length
      || this.state.sortField() !== 'relevancy'
      || !this.allSourcesSelected;
  }

  resetAll(): void {
    this.state.resetFilters();
  }
}
