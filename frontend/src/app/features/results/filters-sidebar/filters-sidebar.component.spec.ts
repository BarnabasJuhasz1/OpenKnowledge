import { describe, beforeEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FiltersSidebarComponent } from './filters-sidebar.component';
import { SearchStateService } from '../../../core/services/search-state.service';

describe('FiltersSidebarComponent archetype distribution', () => {
  let component: FiltersSidebarComponent;
  let state: SearchStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FiltersSidebarComponent],
    });
    const fixture = TestBed.createComponent(FiltersSidebarComponent);
    component = fixture.componentInstance;
    state = TestBed.inject(SearchStateService);
  });

  it('reflects the whole match set when all archetypes are selected (Scholar mode)', () => {
    // Scholar mode is the default; the panel reads the streamed counts.
    state.scholarArchetypeCounts.set({ 'The Innovator': 60, 'The Analyst': 40 });

    const dist = component.archetypeDistribution();
    const innovator = dist.find(d => d.name === 'The Innovator')!;
    const analyst = dist.find(d => d.name === 'The Analyst')!;
    expect(innovator.count).toBe(60);
    expect(innovator.percentage).toBe(60);
    expect(analyst.count).toBe(40);
    expect(analyst.percentage).toBe(40);
  });

  it('updates the distribution when archetypes are filtered out', () => {
    state.scholarArchetypeCounts.set({ 'The Innovator': 60, 'The Analyst': 40 });

    // Deselect The Analyst → it drops to 0 and the remaining recompute over the subset.
    state.toggleArchetype('The Analyst');

    const dist = component.archetypeDistribution();
    const innovator = dist.find(d => d.name === 'The Innovator')!;
    const analyst = dist.find(d => d.name === 'The Analyst')!;
    expect(analyst.count).toBe(0);
    expect(analyst.percentage).toBe(0);
    // The Innovator is now the only selected archetype with papers → 100%.
    expect(innovator.count).toBe(60);
    expect(innovator.percentage).toBe(100);
  });
});
