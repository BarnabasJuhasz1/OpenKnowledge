import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphFiltersPopupComponent } from './graph-filters-popup.component';
import { GraphFilterService } from '../../../core/services/graph-filter.service';
import { SearchStateService } from '../../../core/services/search-state.service';

describe('GraphFiltersPopupComponent', () => {
  let graphFilter: GraphFilterService;
  let search: SearchStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GraphFiltersPopupComponent],
      providers: [provideHttpClient()],
    });
    graphFilter = TestBed.inject(GraphFilterService);
    search = TestBed.inject(SearchStateService);
  });

  it('renders the filter controls', () => {
    const fixture = TestBed.createComponent(GraphFiltersPopupComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Year range');
    expect(text).toContain('Citation count');
    expect(text).toContain('Open access');
    expect(text).toContain('Archetype');
    expect(text).toContain('Field of study');
  });

  it('toggling a control updates GraphFilterService and not the Results filters', () => {
    const fixture = TestBed.createComponent(GraphFiltersPopupComponent);
    fixture.detectChanges();
    const resultsBefore = search.filters();

    fixture.componentInstance.openAccessOnly = true;

    expect(graphFilter.metadata().openAccessOnly).toBe(true);
    // The Retrieved-Results filter state must be untouched.
    expect(search.filters()).toEqual(resultsBefore);
    expect(search.filters().openAccessOnly).toBe(false);
  });

  it('emits closed on close()', () => {
    const fixture = TestBed.createComponent(GraphFiltersPopupComponent);
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    fixture.componentInstance.close();
    expect(closed).toBe(true);
  });
});
