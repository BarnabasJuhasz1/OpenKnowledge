import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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

/** A Response wrapping an SSE ReadableStream: one delta then a `done` event. */
function sseResponse(): Response {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ delta: 'S' })}\n\n`,
    `data: ${JSON.stringify({ done: true, title: 'T', summary: 'S', bullets: ['b1', 'b2', 'b3'], method: 'fallback', model: null })}\n\n`,
  ].map(f => enc.encode(f));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(frames[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Like sseResponse() but holds its first frame until `gate` resolves, simulating
 *  an on-demand model that is cold-starting (no tokens until the GPU is up). */
function gatedSseResponse(gate: Promise<void>): Response {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ delta: 'S' })}\n\n`,
    `data: ${JSON.stringify({ done: true, title: 'T', summary: 'S', bullets: [], method: 'vllm', model: 'default' })}\n\n`,
  ].map(f => enc.encode(f));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i === 0) await gate; // hold the first frame until the model is "warm"
      if (i < frames.length) controller.enqueue(frames[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('ClusterSummaryService', () => {
  let svc: ClusterSummaryService;
  let appRef: ApplicationRef;
  let bodies: any[];
  const rawGraph = signal<any>({
    nodes: NODES, edges: EDGES, seedId: '', resolution: 1, maxLevels: 10,
  });

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return sseResponse();
    }));
    TestBed.configureTestingModule({
      providers: [
        { provide: OkGraphStateService, useValue: { rawGraph } },
      ],
    });
    svc = TestBed.inject(ClusterSummaryService);
    appRef = TestBed.inject(ApplicationRef);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function drain(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      appRef.tick(); // flush the constructor effect / scheduled effects
      await new Promise(r => setTimeout(r, 0));
      if (bodies.length > 0 && !svc.running()) break;
    }
  }

  it('summarizes every cluster across all levels and tracks progress to completion', async () => {
    const exp = expectedHierarchy();
    await drain();

    expect(svc.progress().total).toBe(exp.total);
    expect(svc.progress().done).toBe(exp.total);
    expect(svc.running()).toBe(false);

    const finest = bodies.filter(b => b.kind === 'finest');
    const higher = bodies.filter(b => b.kind === 'higher');
    expect(finest.length).toBe(exp.finest);
    expect(higher.length).toBe(exp.total - exp.finest);

    // Stored finest summaries are retrievable and marked done.
    expect(svc.summaryAt(0, 0)?.status).toBe('done');
    // Glanceable bullets from the `done` event flow into the store.
    expect(svc.summaryAt(0, 0)?.bullets).toEqual(['b1', 'b2', 'b3']);

    // When a coarser level exists, it must have been fed the child summaries
    // (only possible because the finer level finished first — bottom-up).
    if (exp.levels > 1) {
      expect(higher.length).toBeGreaterThan(0);
      for (const h of higher) expect(h.children.length).toBeGreaterThan(0);
    }
  });

  it('re-summarizes after the graph is cleared and rebuilt with the same seed + config', async () => {
    const exp = expectedHierarchy();
    await drain();
    expect(bodies.length).toBe(exp.total);
    expect(svc.summaryAt(0, 0)?.status).toBe('done');

    // Clear the graph (rawGraph -> null): wipes the summary store via reset().
    bodies = [];
    rawGraph.set(null);
    appRef.tick();
    await new Promise(r => setTimeout(r, 0));
    expect(svc.summaryAt(0, 0)).toBeUndefined();

    // Rebuild with the SAME seed + configuration (identical signature). The run
    // must NOT be skipped — summaries have to be regenerated.
    rawGraph.set({ nodes: NODES, edges: EDGES, seedId: '', resolution: 1, maxLevels: 10 });
    await drain();

    expect(bodies.length).toBe(exp.total);
    expect(svc.summaryAt(0, 0)?.status).toBe('done');
  });

  it('bundles sibling fingerprints (co-parented, excluding self) into every prompt', async () => {
    await drain();

    // Every request carries a siblings array of {title, size, archetypes}.
    for (const b of bodies) {
      expect(Array.isArray(b.siblings)).toBe(true);
      for (const s of b.siblings) {
        expect(typeof s.title).toBe('string');
        expect(typeof s.size).toBe('number');
        expect(Array.isArray(s.archetypes)).toBe(true);
      }
    }

    // The finest level has multiple sibling clusters, so at least one finest
    // prompt must have received a non-empty roster; a cluster never lists itself
    // (the four triangles all share the same rep-title shape but distinct sizes
    // are not required — self-exclusion is what we assert via the count).
    const finest = bodies.filter(b => b.kind === 'finest');
    const exp = expectedHierarchy();
    if (exp.finest > 1) {
      expect(finest.some(b => b.siblings.length > 0)).toBe(true);
      // Roster never exceeds (clusters at the level - 1).
      for (const b of finest) expect(b.siblings.length).toBeLessThanOrEqual(exp.finest - 1);
    }
  });

  it('keeps the warm-up notice hidden when summary tokens arrive promptly', async () => {
    await drain();
    expect(svc.warmingUp()).toBe(false);
  });

  it('shows the warm-up notice when the first token is overdue, then hides it', async () => {
    // Tighten the cold-start threshold and gate the model's first token so the
    // notice has time to trip before any token arrives.
    (svc as any).coldStartNoticeMs = 30;
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return gatedSseResponse(gate);
    }));

    expect(svc.warmingUp()).toBe(false);
    appRef.tick(); // fire the constructor effect -> start() arms the warm-up timer
    await new Promise(r => setTimeout(r, 80)); // let the threshold elapse, still no token

    expect(svc.warmingUp()).toBe(true);
    expect(svc.running()).toBe(true);

    openGate(); // model "warms up" — tokens start flowing
    await drain();

    expect(svc.warmingUp()).toBe(false);
    expect(svc.running()).toBe(false);
  });

  it('exposes on-demand cold-start notice copy', () => {
    expect(svc.coldStartNotice).toContain('on-demand');
    expect(svc.coldStartNotice.toLowerCase()).toContain('patient');
  });
});
