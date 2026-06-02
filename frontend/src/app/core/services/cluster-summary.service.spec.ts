import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ClusterSummaryService } from './cluster-summary.service';
import { OkGraphStateService } from './okgraph-state.service';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { louvain, getCommunitiesAtLevel } from '../../features/citgraph/louvain';

function node(id: string): CitGraphNode {
  return {
    paper_id: id,
    doi: null, arxiv_id: null, title: `Paper ${id}`, abstract: `abstract ${id}`,
    year: 2020, citation_count: 1, reference_count: 0, authors: [], journal: null,
    is_open_access: false, pdf_url: null, fields_of_study: [], hop: 0,
    predicted_main_archetype: 'Method', predicted_second_tier_archetype: null,
  };
}

// Four triangles; pairs are interconnected so the dendrogram tends to build a
// second level. The test derives its expectations from louvain() itself, so it
// stays correct regardless of exactly how many levels emerge.
const IDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const NODES: CitGraphNode[] = IDS.map(node);
const EDGES: CitGraphEdge[] = [
  // four triangles
  ['0', '1'], ['1', '2'], ['0', '2'],
  ['3', '4'], ['4', '5'], ['3', '5'],
  ['6', '7'], ['7', '8'], ['6', '8'],
  ['9', '10'], ['10', '11'], ['9', '11'],
  // interconnect triangle pairs (A: t0+t1, B: t2+t3)
  ['2', '3'], ['1', '4'],
  ['8', '9'], ['7', '10'],
  // single weak bridge between super-group A and B
  ['5', '6'],
].map(([source, target]) => ({ source, target }));

function expectedHierarchy() {
  const idx = new Map(NODES.map((n, i) => [n.paper_id, i]));
  const mapped = EDGES.map(e => ({ source: idx.get(e.source)!, target: idx.get(e.target)! }));
  const res = louvain(NODES.length, mapped, { resolution: 1, maxLevels: 10 });
  const perLevel = res.levels.map((_, L) => new Set(getCommunitiesAtLevel(res.levels, NODES.length, L)).size);
  return {
    levels: res.levels.length,
    total: perLevel.reduce((a, b) => a + b, 0),
    finest: perLevel[0] ?? 0,
  };
}

describe('ClusterSummaryService', () => {
  let svc: ClusterSummaryService;
  let httpMock: HttpTestingController;
  let appRef: ApplicationRef;
  const rawGraph = signal<any>({
    nodes: NODES, edges: EDGES, seedId: '', resolution: 1, maxLevels: 10,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: OkGraphStateService, useValue: { rawGraph } },
      ],
    });
    svc = TestBed.inject(ClusterSummaryService);
    httpMock = TestBed.inject(HttpTestingController);
    appRef = TestBed.inject(ApplicationRef);
  });

  async function drain(bodies: any[]): Promise<void> {
    for (let i = 0; i < 120; i++) {
      appRef.tick(); // flush the constructor effect / scheduled effects
      await new Promise(r => setTimeout(r, 0));
      const reqs = httpMock.match(req => req.url.endsWith('/clusters/summarize'));
      for (const req of reqs) {
        bodies.push(req.request.body);
        req.flush({ title: 'T', summary: 'S', method: 'fallback', model: null });
      }
      if (bodies.length > 0 && reqs.length === 0 && !svc.running()) break;
    }
  }

  it('summarizes every cluster across all levels and tracks progress to completion', async () => {
    const exp = expectedHierarchy();
    const bodies: any[] = [];
    await drain(bodies);

    expect(svc.progress().total).toBe(exp.total);
    expect(svc.progress().done).toBe(exp.total);
    expect(svc.running()).toBe(false);

    const finest = bodies.filter(b => b.kind === 'finest');
    const higher = bodies.filter(b => b.kind === 'higher');
    expect(finest.length).toBe(exp.finest);
    expect(higher.length).toBe(exp.total - exp.finest);

    // Stored finest summaries are retrievable and marked done.
    expect(svc.summaryAt(0, 0)?.status).toBe('done');

    // When a coarser level exists, it must have been fed the child summaries
    // (only possible because the finer level finished first — bottom-up).
    if (exp.levels > 1) {
      expect(higher.length).toBeGreaterThan(0);
      for (const h of higher) expect(h.children.length).toBeGreaterThan(0);
    }
  });

  afterEach(() => httpMock.verify());
});
