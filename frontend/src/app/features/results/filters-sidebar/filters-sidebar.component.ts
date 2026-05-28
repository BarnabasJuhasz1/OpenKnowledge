import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SearchStateService, SortField } from '../../../core/services/search-state.service';

@Component({
  selector: 'app-filters-sidebar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './filters-sidebar.component.html',
  styleUrl: './filters-sidebar.component.scss',
})
export class FiltersSidebarComponent {
  readonly state = inject(SearchStateService);

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

  get hasActiveFilters(): boolean {
    const f = this.state.filters();
    return f.yearMin != null || f.yearMax != null
      || f.citationMin != null || f.citationMax != null
      || f.codeOnly || f.peerReviewedOnly || f.openAccessOnly
      || this.state.sortField() !== 'relevancy';
  }

  resetAll(): void {
    this.state.resetFilters();
  }
}
