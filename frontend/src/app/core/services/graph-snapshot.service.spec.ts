import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { OkGraphStateService } from './okgraph-state.service';
import { ClusterSummaryService } from './cluster-summary.service';
import { ProjectContextService } from './project-context.service';
import { NotificationService } from './notification.service';
import { ProjectScoringService } from './project-scoring.service';
import {
  GraphSnapshotService,
  SnapshotError,
  SnapshotGraph,
  SnapshotSummary,
} from './graph-snapshot.service';

const API = `${environment.BACKEND_URL}/api/projects`;

function sampleGraph(): SnapshotGraph {
  return {
    nodes: [{ paper_id: 'n1' }, { paper_id: 'n2' }] as any,
    edges: [],
    seedId: 'n1',
    resolution: 1,
    maxLevels: 10,
    booleanQuery: 'foo',
    keywords: ['foo'],
    prefiltered: false,
    initialSeedIds: ['n1'],
    directionalSplit: false,
  };
}

const sampleSummaries: SnapshotSummary[] = [
  { level: 1, community: 0, title: 'A', summary: 's', bullets: ['x'] },
];

function apiMeta(over: Record<string, unknown> = {}) {
  return {
    id: 7, name: 'snap', seed_id: 'n1', node_count: 2, cluster_count: 1,
    created_at: 'c', updated_at: 'u', ...over,
  };
}

describe('GraphSnapshotService', () => {
  let svc: GraphSnapshotService;
  let httpMock: HttpTestingController;
  let graph: SnapshotGraph | null;
  let activeId: number | null;
  let hydrate: ReturnType<typeof vi.fn>;
  let loadSnapshotGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    graph = sampleGraph();
    activeId = 42;
    hydrate = vi.fn();
    loadSnapshotGraph = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        GraphSnapshotService,
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: OkGraphStateService,
          useValue: { exportSnapshotGraph: () => graph, loadSnapshotGraph },
        },
        {
          provide: ClusterSummaryService,
          useValue: { exportSummaries: () => sampleSummaries, hydrate },
        },
        { provide: ProjectContextService, useValue: { activeProjectId: () => activeId } },
      ],
    });
    svc = TestBed.inject(GraphSnapshotService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('save posts {name, graph, summaries} and maps the response to camelCase', () => {
    let result: any;
    svc.save(42, 'snap').subscribe(r => (result = r));
    const req = httpMock.expectOne(`${API}/42/snapshots`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      name: 'snap', graph: sampleGraph(), summaries: sampleSummaries,
    });
    req.flush(apiMeta());
    expect(result).toEqual({
      id: 7, name: 'snap', seedId: 'n1', nodeCount: 2, clusterCount: 1,
      createdAt: 'c', updatedAt: 'u',
    });
  });

  it('save fails with no-graph (and issues no request) when nothing is built', () => {
    graph = null;
    let err: SnapshotError | undefined;
    svc.save(42, 'snap').subscribe({ error: e => (err = e) });
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err!.kind).toBe('no-graph');
    httpMock.expectNone(() => true);
  });

  it('maps a 409 cap response to SnapshotError("limit")', () => {
    let err: SnapshotError | undefined;
    svc.save(42, 'snap').subscribe({ error: e => (err = e) });
    httpMock.expectOne(`${API}/42/snapshots`).flush(
      { detail: 'Snapshot limit reached — delete one first' },
      { status: 409, statusText: 'Conflict' },
    );
    expect(err!.kind).toBe('limit');
  });

  it('maps a 409 name clash to SnapshotError("duplicate-name")', () => {
    let err: SnapshotError | undefined;
    svc.save(42, 'snap').subscribe({ error: e => (err = e) });
    httpMock.expectOne(`${API}/42/snapshots`).flush(
      { detail: 'A snapshot with that name already exists' },
      { status: 409, statusText: 'Conflict' },
    );
    expect(err!.kind).toBe('duplicate-name');
  });

  it('list GETs the collection and maps each row', () => {
    let rows: any[] | undefined;
    svc.list(42).subscribe(r => (rows = r));
    const req = httpMock.expectOne(`${API}/42/snapshots`);
    expect(req.request.method).toBe('GET');
    req.flush([apiMeta(), apiMeta({ id: 8 })]);
    expect(rows!.map(r => r.id)).toEqual([7, 8]);
    expect(rows![0].nodeCount).toBe(2);
  });

  it('load GETs the active-project snapshot and includes the deserialized blobs', () => {
    let detail: any;
    svc.load(7).subscribe(r => (detail = r));
    const req = httpMock.expectOne(`${API}/42/snapshots/7`);
    expect(req.request.method).toBe('GET');
    req.flush({ ...apiMeta(), graph: sampleGraph(), summaries: sampleSummaries });
    expect(detail.seedId).toBe('n1');
    expect(detail.graph.seedId).toBe('n1');
    expect(detail.summaries).toHaveLength(1);
  });

  it('rename PATCHes the active-project snapshot', () => {
    svc.rename(7, 'new name').subscribe();
    const req = httpMock.expectOne(`${API}/42/snapshots/7`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'new name' });
    req.flush(apiMeta({ name: 'new name' }));
  });

  it('delete DELETEs the active-project snapshot', () => {
    svc.delete(7).subscribe();
    const req = httpMock.expectOne(`${API}/42/snapshots/7`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('applySnapshot hydrates summaries BEFORE rebuilding the graph (no re-summarize)', () => {
    const calls: string[] = [];
    hydrate.mockImplementation(() => calls.push('hydrate'));
    loadSnapshotGraph.mockImplementation(() => calls.push('loadSnapshotGraph'));

    const detail = { graph: sampleGraph(), summaries: sampleSummaries } as any;
    svc.applySnapshot(detail);

    // Order is load-bearing: signature pre-seed (hydrate) must precede the graph
    // update (loadSnapshotGraph), or the effect would re-summarize.
    expect(calls).toEqual(['hydrate', 'loadSnapshotGraph']);
    // Hydrate gets the raw graph slice + the saved summaries.
    expect(hydrate).toHaveBeenCalledWith(
      {
        nodes: sampleGraph().nodes,
        edges: sampleGraph().edges,
        resolution: 1,
        maxLevels: 10,
        seedId: 'n1',
      },
      sampleSummaries,
    );
    expect(loadSnapshotGraph).toHaveBeenCalledWith(detail.graph);
  });

  it('loadAndApply fetches the snapshot then applies it', () => {
    let detail: any;
    svc.loadAndApply(7).subscribe(d => (detail = d));
    httpMock
      .expectOne(`${API}/42/snapshots/7`)
      .flush({ ...apiMeta(), graph: sampleGraph(), summaries: sampleSummaries });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(loadSnapshotGraph).toHaveBeenCalledTimes(1);
    expect(detail.graph.seedId).toBe('n1');
  });

  it('by-id ops fail with no-project (and no request) when none is active', () => {
    activeId = null;
    let err: SnapshotError | undefined;
    svc.load(7).subscribe({ error: e => (err = e) });
    expect(err!.kind).toBe('no-project');
    httpMock.expectNone(() => true);
  });
});

describe('ClusterSummaryService.signatureFor', () => {
  it('matches the documented formula exactly', () => {
    TestBed.configureTestingModule({
      providers: [
        ClusterSummaryService,
        { provide: OkGraphStateService, useValue: { rawGraph: () => null } },
        { provide: NotificationService, useValue: {} },
        { provide: ProjectScoringService, useValue: { defaults: () => ({}), load: () => ({}) } },
        { provide: ProjectContextService, useValue: { activeProjectId: () => null } },
      ],
    });
    const svc = TestBed.inject(ClusterSummaryService);
    const raw = {
      nodes: [{ paper_id: 'first' }, { paper_id: 'mid' }, { paper_id: 'last' }] as any,
      edges: [{}, {}] as any,
      resolution: 1.25,
      maxLevels: 7,
      seedId: 'seed-x',
    };
    // nodes.length | edges.length | resolution | maxLevels | seedId | first id | last id
    expect(svc.signatureFor(raw)).toBe('3|2|1.25|7|seed-x|first|last');
  });
});
