import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { OkGraphStateService } from './okgraph-state.service';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { louvain, getCommunitiesAtLevel, LouvainResult } from '../../features/citgraph/louvain';
import { repScore } from '../../features/okgraph/cit-node';

export interface ClusterSummary {
  title: string;
  summary: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface PaperPayload { title: string; abstract: string; archetypes: string[]; }
interface ChildPayload { title: string; summary: string; }
/** One Server-Sent event from /clusters/summarize. */
interface SummaryEvent {
  delta?: string;
  done?: boolean;
  title?: string;
  summary?: string;
  method?: string;
  model?: string | null;
}

/** How many summary streams run concurrently within one hierarchy level. */
const CONCURRENCY = 4;

/**
 * Summarizes every cluster at every hierarchy level in the background, bottom-up:
 * the finest clusters (hierarchy index 0) are summarized from their papers'
 * title/abstract/archetypes; each higher level is summarized from the
 * {title, summary} outputs of the level below it — mirroring the Louvain
 * dendrogram. Results are keyed by `(hierarchyIndex, communityId)`.
 *
 * Source of truth is `OkGraphStateService.rawGraph()`: Louvain is deterministic,
 * so re-running it here with the stored params reproduces exactly the community
 * ids the Clustering view computes from the same graph, letting both views read
 * summaries by `(index, communityId)` with no extra plumbing.
 */
@Injectable({ providedIn: 'root' })
export class ClusterSummaryService {
  private readonly okGraphState = inject(OkGraphStateService);
  private readonly baseUrl = `${environment.BACKEND_URL}/api`;

  private store = new Map<string, ClusterSummary>();
  private rawCommunityMap = new Map<string, number>();
  readonly rawTopLevel = signal<number>(-1);
  private readonly version = signal(0);

  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });
  readonly running = signal(false);

  readonly percent = computed(() => {
    const { done, total } = this.progress();
    return total > 0 ? Math.round((done / total) * 100) : 0;
  });

  private signature = '';
  private runId = 0;

  constructor() {
    // Kick off (re)summarization in the background whenever a new graph is built.
    effect(() => {
      const raw = this.okGraphState.rawGraph();
      if (!raw || !raw.nodes.length) {
        this.reset();
        return;
      }
      const sig = `${raw.nodes.length}|${raw.edges.length}|${raw.resolution}|${raw.maxLevels}|${raw.seedId}|${raw.nodes[0]?.paper_id ?? ''}|${raw.nodes[raw.nodes.length - 1]?.paper_id ?? ''}`;
      if (sig === this.signature) return;
      this.signature = sig;
      void this.start(raw.nodes, raw.edges, raw.resolution, raw.maxLevels);
    }, { allowSignalWrites: true });
  }

  /** Look up a cluster's summary by hierarchy index + community id. */
  summaryAt(index: number, community: number): ClusterSummary | undefined {
    this.version(); // register reactive dependency
    return this.store.get(`${index}:${community}`);
  }

  getRawCommunity(paperId: string): number | undefined {
    return this.rawCommunityMap.get(paperId);
  }

  getTopLevel(): number {
    return this.rawTopLevel();
  }

  clear(): void {
    this.signature = '';
    this.reset();
  }

  private reset(): void {
    this.runId++;
    this.store = new Map();
    this.rawCommunityMap = new Map();
    this.rawTopLevel.set(-1);
    this.version.update(v => v + 1);
    this.progress.set({ done: 0, total: 0 });
    this.running.set(false);
  }

  private set(key: string, value: ClusterSummary): void {
    this.store.set(key, value);
    this.version.update(v => v + 1);
  }

  // --- orchestration ---------------------------------------------------------

  private async start(
    nodes: CitGraphNode[],
    edges: CitGraphEdge[],
    resolution: number,
    maxLevels: number,
  ): Promise<void> {
    this.runId++;
    const myRun = this.runId;
    this.store = new Map();
    this.rawCommunityMap = new Map();
    this.rawTopLevel.set(-1);
    this.version.update(v => v + 1);

    const result = this.cluster(nodes, edges, resolution, maxLevels);
    const levels = result.levels;
    if (!levels.length) {
      this.rawTopLevel.set(-1);
      this.rawCommunityMap = new Map();
      this.progress.set({ done: 0, total: 0 });
      this.running.set(false);
      return;
    }

    const topLvl = levels.length - 1;
    this.rawTopLevel.set(topLvl);

    // Precompute the community assignment + members for every level.
    const n = nodes.length;
    const commAt: number[][] = levels.map((_, L) => getCommunitiesAtLevel(levels, n, L));

    // Map paper_id to its raw top-level community ID
    const commAtTop = commAt[topLvl];
    this.rawCommunityMap = new Map();
    nodes.forEach((node, i) => {
      this.rawCommunityMap.set(node.paper_id, commAtTop[i]);
    });
    const membersAt: Map<number, number[]>[] = commAt.map(comm => {
      const m = new Map<number, number[]>();
      comm.forEach((c, i) => {
        const arr = m.get(c);
        if (arr) arr.push(i); else m.set(c, [i]);
      });
      return m;
    });

    const total = membersAt.reduce((s, m) => s + m.size, 0);
    this.progress.set({ done: 0, total });
    this.running.set(true);

    // Bottom-up: a level must finish before the next (higher needs child summaries).
    for (let L = 0; L < levels.length; L++) {
      if (myRun !== this.runId) return;
      const clusters = [...membersAt[L].keys()];
      await this.runLevel(clusters, async (community) => {
        if (myRun !== this.runId) return;
        const members = membersAt[L].get(community)!;
        const key = `${L}:${community}`;
        this.set(key, { title: '', summary: '', status: 'running' });
        const repTitle = this.representativeTitle(nodes, members);

        let res: ClusterSummary;
        try {
          if (L === 0) {
            res = await this.summarizeFinest(nodes, members, repTitle, key, myRun);
          } else {
            res = await this.summarizeHigher(L, commAt[L - 1], members, repTitle, key, myRun);
          }
        } catch {
          res = { title: repTitle, summary: this.localFallback(members.length, repTitle), status: 'error' };
        }
        if (myRun !== this.runId) return;
        this.set(key, res);
        this.progress.update(p => ({ done: p.done + 1, total: p.total }));
      }, myRun);
    }

    if (myRun === this.runId) this.running.set(false);
  }

  /** Reproduce the Clustering view's Louvain run over the shared raw graph. */
  private cluster(
    nodes: CitGraphNode[],
    edges: CitGraphEdge[],
    resolution: number,
    maxLevels: number,
  ): LouvainResult {
    const idxOf = new Map(nodes.map((node, i) => [node.paper_id, i]));
    const mapped = edges
      .map(e => ({ source: idxOf.get(e.source) ?? -1, target: idxOf.get(e.target) ?? -1 }))
      .filter(e => e.source >= 0 && e.target >= 0);
    return louvain(nodes.length, mapped, { resolution, maxLevels });
  }

  private async runLevel(
    clusters: number[],
    fn: (c: number) => Promise<void>,
    myRun: number,
  ): Promise<void> {
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < clusters.length && myRun === this.runId) {
        await fn(clusters[idx++]);
      }
    };
    const pool = Array.from({ length: Math.min(CONCURRENCY, clusters.length) }, worker);
    await Promise.all(pool);
  }

  private representativeTitle(nodes: CitGraphNode[], members: number[]): string {
    let best = members[0];
    let bestScore = -Infinity;
    for (const i of members) {
      const s = repScore(nodes[i]);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return nodes[best]?.title ?? '';
  }

  private localFallback(count: number, repTitle: string): string {
    return `A group of ${count} related paper${count === 1 ? '' : 's'}${repTitle ? `, e.g. "${repTitle}"` : ''}.`;
  }

  private async summarizeFinest(
    nodes: CitGraphNode[],
    members: number[],
    repTitle: string,
    key: string,
    myRun: number,
  ): Promise<ClusterSummary> {
    const papers: PaperPayload[] = members.map(i => {
      const node = nodes[i];
      const archetypes = [node.predicted_main_archetype, node.predicted_second_tier_archetype]
        .filter((a): a is string => !!a && a !== 'None');
      return { title: node.title, abstract: node.abstract ?? '', archetypes };
    });
    return this.streamSummarize({ kind: 'finest', papers }, key, repTitle, myRun);
  }

  private async summarizeHigher(
    level: number,
    childComm: number[],
    members: number[],
    repTitle: string,
    key: string,
    myRun: number,
  ): Promise<ClusterSummary> {
    // Child community ids (at index level-1) whose nodes compose into this cluster.
    const childIds = new Set<number>();
    for (const i of members) childIds.add(childComm[i]);

    const children: ChildPayload[] = [];
    for (const childId of childIds) {
      const child = this.store.get(`${level - 1}:${childId}`);
      if (!child) continue;
      const summary = child.summary || child.title;
      if (summary) children.push({ title: child.title, summary });
    }
    if (!children.length) {
      return { title: repTitle, summary: this.localFallback(members.length, repTitle), status: 'done' };
    }
    return this.streamSummarize({ kind: 'higher', children }, key, repTitle, myRun);
  }

  /**
   * POST the cluster to the streaming summarize endpoint and consume its
   * Server-Sent Events, rendering the summary live: each `delta` grows a text
   * buffer (first non-empty line = title, the rest = summary) and updates the
   * store with `status: 'running'`; the terminal `done` event carries the
   * authoritative title/summary. Throws on a network / non-2xx response so the
   * caller writes the local fallback.
   */
  private async streamSummarize(
    body: unknown,
    key: string,
    repTitle: string,
    myRun: number,
  ): Promise<ClusterSummary> {
    const resp = await fetch(`${this.baseUrl}/clusters/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) throw new Error(`summarize failed: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    let text = '';
    let final: ClusterSummary | null = null;

    const handle = (evt: SummaryEvent): void => {
      if (evt.done) {
        final = {
          title: evt.title || repTitle,
          summary: evt.summary ?? text,
          status: 'done',
        };
        return;
      }
      if (evt.delta) {
        text += evt.delta;
        if (myRun === this.runId) this.set(key, { ...this.splitTitleSummary(text), status: 'running' });
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (value) sseBuf += decoder.decode(value, { stream: true });
      // SSE messages are separated by a blank line.
      let sep: number;
      while ((sep = sseBuf.indexOf('\n\n')) !== -1) {
        const raw = sseBuf.slice(0, sep);
        sseBuf = sseBuf.slice(sep + 2);
        const data = raw.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim())
          .join('');
        if (data) {
          try { handle(JSON.parse(data) as SummaryEvent); } catch { /* skip malformed frame */ }
        }
      }
      if (done) break;
    }

    return final ?? { title: repTitle, summary: text || this.localFallback(0, repTitle), status: 'done' };
  }

  /** Live cosmetic parse: first non-empty line is the title, the rest the summary. */
  private splitTitleSummary(text: string): { title: string; summary: string } {
    const lines = text.split('\n');
    const i = lines.findIndex(l => l.trim());
    if (i === -1) return { title: '', summary: '' };
    return { title: lines[i].trim(), summary: lines.slice(i + 1).join('\n').trim() };
  }
}
