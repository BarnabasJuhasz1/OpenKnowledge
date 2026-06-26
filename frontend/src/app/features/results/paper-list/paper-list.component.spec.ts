import { describe, beforeEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PaperListComponent } from './paper-list.component';
import { Paper } from '../../../core/models/paper.model';

function makePaper(title: string): Paper {
  return { title } as Paper;
}

describe('PaperListComponent — loading skeleton', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PaperListComponent>>;
  let component: PaperListComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PaperListComponent] });
    fixture = TestBed.createComponent(PaperListComponent);
    component = fixture.componentInstance;
  });

  function html(): string {
    return (fixture.nativeElement as HTMLElement).innerHTML;
  }

  function skeletonCount(): number {
    return (fixture.nativeElement as HTMLElement).querySelectorAll('.skeleton-card').length;
  }

  function cardCount(): number {
    return (fixture.nativeElement as HTMLElement).querySelectorAll('app-paper-card').length;
  }

  it('renders a full page of skeleton rows and no real cards while loading', () => {
    // The requested page maps to a window that is still being fetched. Even though stale
    // papers from the previous window are still bound, none of them should render.
    component.papers = Array.from({ length: 100 }, (_, i) => makePaper(`Stale ${i}`));
    component.page = 1;
    component.clientPaginate = true;
    component.loading = true;
    fixture.detectChanges();

    expect(skeletonCount()).toBe(component.skeletonRows.length);
    expect(cardCount()).toBe(0);
    // The stale title from the previous window must not leak through.
    expect(html()).not.toContain('Stale 0');
  });

  it('renders real cards and no skeletons once loading clears', () => {
    component.papers = [makePaper('Real A'), makePaper('Real B')];
    component.page = 1;
    component.clientPaginate = true;
    component.loading = false;
    fixture.detectChanges();

    expect(skeletonCount()).toBe(0);
    expect(cardCount()).toBe(2);
  });
});
