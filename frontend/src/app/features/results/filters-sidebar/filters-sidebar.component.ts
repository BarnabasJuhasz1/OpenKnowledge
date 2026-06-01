import { Component, ElementRef, HostListener, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ALL_SOURCES, SearchStateService, SortField, ALL_ARCHETYPES } from '../../../core/services/search-state.service';

@Component({
  selector: 'app-filters-sidebar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './filters-sidebar.component.html',
  styleUrl: './filters-sidebar.component.scss',
})
export class FiltersSidebarComponent {
  readonly state = inject(SearchStateService);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Whether the databases dropdown menu is open. */
  databasesOpen = false;

  /** Whether the archetypes dropdown menu is open. */
  archetypesOpen = false;

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
    const range = this.state.yearRange();
    this.state.updateFilter({ yearMin: val <= range.min ? null : val });
  }

  get yearMax(): number {
    return this.state.filters().yearMax ?? this.state.yearRange().max;
  }

  set yearMax(val: number) {
    const range = this.state.yearRange();
    this.state.updateFilter({ yearMax: val >= range.max ? null : val });
  }

  get citationMin(): number {
    return this.state.filters().citationMin ?? 0;
  }

  set citationMin(val: number) {
    this.state.updateFilter({ citationMin: val <= 0 ? null : val });
  }

  get citationMax(): number {
    return this.state.filters().citationMax ?? this.state.citationRange().max;
  }

  set citationMax(val: number) {
    const range = this.state.citationRange();
    this.state.updateFilter({ citationMax: val >= range.max ? null : val });
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

  getArchetypePaperCount(arch: string): number {
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
      || this.state.sortField() !== 'relevancy'
      || !this.allSourcesSelected;
  }

  resetAll(): void {
    this.state.resetFilters();
  }
}
