import { describe, beforeEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OkGraphStateService } from './okgraph-state.service';

describe('OkGraphStateService', () => {
  let service: OkGraphStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OkGraphStateService]
    });
    service = TestBed.inject(OkGraphStateService);
  });

  it('should initialize panelCollapsed and autoOpenEnabled to true', () => {
    expect(service.panelCollapsed()).toBe(true);
    expect(service.autoOpenEnabled()).toBe(true);
  });

  it('should reset panelCollapsed and autoOpenEnabled to true on clear()', () => {
    service.panelCollapsed.set(false);
    service.autoOpenEnabled.set(false);

    expect(service.panelCollapsed()).toBe(false);
    expect(service.autoOpenEnabled()).toBe(false);

    service.clear();

    expect(service.panelCollapsed()).toBe(true);
    expect(service.autoOpenEnabled()).toBe(true);
  });

  it('markRemoved accumulates ids (irreversible removal set)', () => {
    expect(service.removedIds().size).toBe(0);
    service.markRemoved(['a', 'b']);
    service.markRemoved(['b', 'c']);
    expect([...service.removedIds()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('resets removedIds on clear()', () => {
    service.markRemoved(['a']);
    expect(service.removedIds().size).toBe(1);
    service.clear();
    expect(service.removedIds().size).toBe(0);
  });

  it('resets removedIds on a new graph (setHierarchy)', () => {
    service.markRemoved(['a']);
    service.setHierarchy({
      nodes: [], louvain: { levels: [] } as any, edges: [],
      resolution: 1, maxLevels: 10, keywords: [], booleanQuery: '', seedId: '', prefiltered: false,
    });
    expect(service.removedIds().size).toBe(0);
  });

  it('keyword filter toggles on the boolean query and re-clusters matches', () => {
    const nodes = [
      { paper_id: 'seed', title: 'seed paper', abstract: '' },
      { paper_id: 'a', title: 'transformer efficiency', abstract: '' },
      { paper_id: 'b', title: 'unrelated topic', abstract: '' },
    ] as any[];
    const louvainStub = { levels: [[0, 1, 2]] } as any;
    service.setHierarchy({
      nodes, louvain: louvainStub, edges: [],
      resolution: 1, maxLevels: 10, keywords: [], booleanQuery: 'transformer',
      seedId: 'seed', prefiltered: false,
    });
    expect(service.canToggleFilter()).toBe(true);
    service.setFilter(true);
    const keptIds = service.nodes().map(n => n.paper_id).sort();
    // seed always kept + the matching node; non-matching 'b' dropped.
    expect(keptIds).toEqual(['a', 'seed']);
    service.setFilter(false);
    expect(service.nodes().length).toBe(3);
  });

  it('cannot toggle the keyword filter without a boolean query', () => {
    service.setHierarchy({
      nodes: [{ paper_id: 'x', title: 't', abstract: '' }] as any[],
      louvain: { levels: [[0]] } as any, edges: [],
      resolution: 1, maxLevels: 10, keywords: [], booleanQuery: '',
      seedId: 'x', prefiltered: false,
    });
    expect(service.canToggleFilter()).toBe(false);
  });
});
