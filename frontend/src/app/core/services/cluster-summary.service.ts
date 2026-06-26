import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { OkGraphStateService } from './okgraph-state.service';
import { NotificationService } from './notification.service';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { louvain, getCommunitiesAtLevel, LouvainResult } from '../../features/citgraph/louvain';
import { okScore } from '../../features/okgraph/cit-node';
import { ProjectScoringService } from './project-scoring.service';
import { ProjectContextService } from './project-context.service';
import { ScoreWeights } from '../models/paper.model';

export interface ClusterSummary {
  title: string;
  summary: string;
  /** Up to 3 short note-style keyword phrases for a fast glance at the cluster. */
  bullets: string[];
  status: 'pending' | 'running' | 'done' | 'error';
}

interface PaperPayload { title: string; abstract: string; archetypes: string[]; }
interface ChildPayload { title: string; summary: string; }
/** Compact structural fingerprint of a sibling cluster at the same level. */
interface SiblingPayload { title: string; size: number; archetypes: string[]; }
/** One Server-Sent event from /clusters/summarize. */
interface SummaryEvent {
  delta?: string;
  done?: boolean;
  title?: string;
  summary?: string;
  bullets?: string[];
  method?: string;
  model?: string | null;
}

/** How many summary streams run concurrently within one hierarchy level.
 *  Configured via SUMMARY_CONCURRENCY (frontend .env → environment). */
const CONCURRENCY = Math.max(1, Math.floor(environment.SUMMARY_CONCURRENCY ?? 8));

/** How many top-scoring (by ok-score) papers per cluster are sent to the finest
 *  summarization prompt. Configured via SUMMARY_TOP_K (frontend .env). */
const TOP_K = Math.max(1, Math.floor(environment.SUMMARY_TOP_K ?? 15));

/** How many sibling-cluster fingerprints (co-parented, highest-size first) are
 *  bundled into each prompt for contrastive context. Configured via
 *  SUMMARY_SIBLING_CAP (frontend .env). */
const SIBLING_CAP = Math.max(0, Math.floor(environment.SUMMARY_SIBLING_CAP ?? 12));

/** How many dominant archetypes describe each cluster in its sibling fingerprint. */
const SIBLING_ARCHETYPES = 2;

/** The summarization model runs on-demand (Cloud Run scale-to-zero). If the first
 *  token takes longer than this, we assume a cold start and surface a warm-up
 *  notice. Configured via SUMMARY_COLD_START_NOTICE_SEC (frontend .env). */
const COLD_START_NOTICE_MS = Math.max(1, Math.floor(environment.SUMMARY_COLD_START_NOTICE_SEC ?? 6)) * 1000;

/** Copy-only knob for the warm-up notice: roughly how long a cold load takes.
 *  (The idle-to-sleep window is Cloud Run-managed and not quoted, so the copy
 *  stays deliberately vague about when the model goes to sleep.) */
const WARMUP_MINUTES = Math.max(1, Math.floor(environment.SUMMARY_WARMUP_MINUTES ?? 1));

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
  private readonly notify = inject(NotificationService);
  private readonly scoring = inject(ProjectScoringService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly baseUrl = `${environment.BACKEND_URL}/api`;

  // Active project's ok-score weights, captured per summarization run so the
  // top-k paper selection and representative pick rank by the project ok-score.
  private weights: ScoreWeights = this.scoring.defaults();

  private store = new Map<string, ClusterSummary>();
  private rawCommunityMap = new Map<string, number>();
  readonly rawTopLevel = signal<number>(-1);
  private readonly version = signal(0);

  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });
  readonly running = signal(false);

  /** True while the first summary token is overdue — the on-demand model is
   *  likely loading from a cold start. Drives the "please be patient" notice. */
  readonly warmingUp = signal(false);

  /** User-facing copy for the cold-start notice (load estimate is env-configurable). */
  readonly coldStartNotice =
    `Please be patient. For this alpha version, the summarization model runs ` +
    `on-demand and spins down when it's been idle for a while. If it has gone to ` +
    `sleep, it needs about ${WARMUP_MINUTES} minute${WARMUP_MINUTES === 1 ? '' : 's'} to ` +
    `load before summaries start streaming.`;

  // Whether the current run has received its first summary token yet, the pending
  // warm-up timer, and the threshold (overridable in tests).
  private firstTokenSeen = false;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private coldStartNoticeMs = COLD_START_NOTICE_MS;

  /** Stats from the most recently completed summarization run, for the OK-Graph
   *  info panel. Null until a run finishes (or after a reset). */
  readonly summaryStats = signal<{ clusters: number; totalMs: number; model: string | null } | null>(null);
  // Model name reported by the streaming endpoint during the current run.
  private lastModel: string | null = null;

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
    // Clear the content signature too: emptying the graph (e.g. a "clear") must
    // re-arm the next build to re-summarize. Otherwise rebuilding the same seed +
    // configuration produces an identical signature, the trigger effect skips it
    // as "already summarized", and the freshly-cleared store stays empty.
    this.signature = '';
    this.runId++;
    this.store = new Map();
    this.rawCommunityMap = new Map();
    this.rawTopLevel.set(-1);
    this.version.update(v => v + 1);
    this.progress.set({ done: 0, total: 0 });
    this.running.set(false);
    this.summaryStats.set(null);
    this.lastModel = null;
    this.clearWarmupNotice();
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
    this.summaryStats.set(null);
    this.lastModel = null;
    this.weights = this.scoring.load(this.projectContext.activeProjectId());

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

    // Structural fingerprint (rep title, size, dominant archetypes) of every
    // cluster at every level, plus each cluster's parent at the level above —
    // all derived from the deterministic Louvain assignment before any
    // summarization runs, so sibling context never serializes the level.
    const fingerprintAt: Map<number, SiblingPayload>[] = membersAt.map(m => {
      const fp = new Map<number, SiblingPayload>();
      for (const [community, members] of m) fp.set(community, this.clusterFingerprint(nodes, members));
      return fp;
    });
    const parentAt: Map<number, number>[] = membersAt.map((m, L) => {
      const pm = new Map<number, number>();
      if (L < topLvl) for (const [community, members] of m) pm.set(community, commAt[L + 1][members[0]]);
      return pm;
    });

    const total = membersAt.reduce((s, m) => s + m.size, 0);
    this.progress.set({ done: 0, total });
    this.running.set(true);
    const startTime = Date.now();
    this.armWarmupNotice(myRun);

    // Bottom-up: a level must finish before the next (higher needs child summaries).
    for (let L = 0; L < levels.length; L++) {
      if (myRun !== this.runId) return;
      const clusters = [...membersAt[L].keys()];
      await this.runLevel(clusters, async (community) => {
        if (myRun !== this.runId) return;
        const members = membersAt[L].get(community)!;
        const key = `${L}:${community}`;
        this.set(key, { title: '', summary: '', bullets: [], status: 'running' });
        const repTitle = this.representativeTitle(nodes, members);
        const siblings = this.siblingsOf(L, community, topLvl, membersAt, fingerprintAt, parentAt);

        let res: ClusterSummary;
        try {
          if (L === 0) {
            res = await this.summarizeFinest(nodes, members, repTitle, key, siblings, myRun);
          } else {
            res = await this.summarizeHigher(L, commAt[L - 1], members, repTitle, key, siblings, myRun);
          }
        } catch {
          res = { title: repTitle, summary: this.localFallback(members.length, repTitle), bullets: [], status: 'error' };
        }
        if (myRun !== this.runId) return;
        this.set(key, res);
        this.progress.update(p => ({ done: p.done + 1, total: p.total }));
      }, myRun);
    }

    if (myRun === this.runId) {
      this.running.set(false);
      this.clearWarmupNotice();
      // Record stats and announce completion only for runs that actually
      // generated something and weren't superseded/cancelled (myRun guard above).
      if (total > 0) {
        const totalMs = Date.now() - startTime;
        this.summaryStats.set({ clusters: total, totalMs, model: this.lastModel });
        this.notify.show(
          `Cluster summaries ready — generated ${total} summar${total === 1 ? 'y' : 'ies'} in ${this.formatDuration(totalMs)}.`,
          5000,
        );
      }
    }
  }

  /** Human-readable elapsed time: "12.3s" under a minute, "2m 5s" above. */
  private formatDuration(ms: number): string {
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
    const min = Math.floor(totalSec / 60);
    const sec = Math.round(totalSec % 60);
    return `${min}m ${sec}s`;
  }

  // --- cold-start warm-up notice ---------------------------------------------

  /** Arm the warm-up notice: if no summary token arrives within the threshold,
   *  the on-demand model is likely cold-starting, so show the notice. */
  private armWarmupNotice(myRun: number): void {
    this.clearWarmupNotice();
    this.firstTokenSeen = false;
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      if (myRun === this.runId && !this.firstTokenSeen) this.warmingUp.set(true);
    }, this.coldStartNoticeMs);
  }

  /** First summary token (delta or done) arrived — the model is warm, so cancel
   *  the pending notice and hide any that already showed. */
  private markFirstToken(): void {
    if (this.firstTokenSeen) return;
    this.firstTokenSeen = true;
    this.clearWarmupNotice();
  }

  /** User-dismissed the warm-up notice: hide it (and cancel any pending timer so
   *  it won't reappear for the current summary run). */
  dismissWarmupNotice(): void {
    this.clearWarmupNotice();
  }

  /** Cancel any pending warm-up timer and hide the notice. */
  private clearWarmupNotice(): void {
    if (this.warmupTimer !== null) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    this.warmingUp.set(false);
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
      const s = okScore(nodes[i], this.weights);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return nodes[best]?.title ?? '';
  }

  /** Compact structural fingerprint of a cluster used as sibling contrast
   *  context: its representative title, size, and most common archetypes. */
  private clusterFingerprint(nodes: CitGraphNode[], members: number[]): SiblingPayload {
    const counts = new Map<string, number>();
    for (const i of members) {
      const node = nodes[i];
      for (const a of [node.predicted_main_archetype, node.predicted_second_tier_archetype]) {
        if (a && a !== 'None') counts.set(a, (counts.get(a) ?? 0) + 1);
      }
    }
    const archetypes = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, SIBLING_ARCHETYPES)
      .map(([a]) => a);
    return { title: this.representativeTitle(nodes, members), size: members.length, archetypes };
  }

  /** Fingerprints of the clusters this one sits alongside at the same level —
   *  scoped to co-parented siblings (same parent at the level above) so the
   *  roster stays small and relevant, and capped to SIBLING_CAP by size. At the
   *  top level (no parent) all other top-level clusters are siblings. */
  private siblingsOf(
    level: number,
    community: number,
    topLvl: number,
    membersAt: Map<number, number[]>[],
    fingerprintAt: Map<number, SiblingPayload>[],
    parentAt: Map<number, number>[],
  ): SiblingPayload[] {
    if (SIBLING_CAP === 0) return [];
    const fp = fingerprintAt[level];
    const parent = parentAt[level].get(community);
    const sibs: SiblingPayload[] = [];
    for (const c of membersAt[level].keys()) {
      if (c === community) continue;
      if (level < topLvl && parentAt[level].get(c) !== parent) continue;
      const f = fp.get(c);
      if (f) sibs.push(f);
    }
    return sibs.sort((a, b) => b.size - a.size).slice(0, SIBLING_CAP);
  }

  private localFallback(count: number, repTitle: string): string {
    return `A group of ${count} related paper${count === 1 ? '' : 's'}${repTitle ? `, e.g. "${repTitle}"` : ''}.`;
  }

  private async summarizeFinest(
    nodes: CitGraphNode[],
    members: number[],
    repTitle: string,
    key: string,
    siblings: SiblingPayload[],
    myRun: number,
  ): Promise<ClusterSummary> {
    // Only the TOP_K highest ok-score papers are sent to the prompt: large
    // clusters would otherwise produce huge, slow prompts. Ranking uses the
    // project ok-score under the active weights (see okScore in cit-node.ts).
    const topMembers = [...members]
      .sort((a, b) => okScore(nodes[b], this.weights) - okScore(nodes[a], this.weights))
      .slice(0, TOP_K);
    const papers: PaperPayload[] = topMembers.map(i => {
      const node = nodes[i];
      const archetypes = [node.predicted_main_archetype, node.predicted_second_tier_archetype]
        .filter((a): a is string => !!a && a !== 'None');
      return { title: node.title, abstract: node.abstract ?? '', archetypes };
    });
    return this.streamSummarize({ kind: 'finest', papers, siblings }, key, repTitle, myRun);
  }

  private async summarizeHigher(
    level: number,
    childComm: number[],
    members: number[],
    repTitle: string,
    key: string,
    siblings: SiblingPayload[],
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
      return { title: repTitle, summary: this.localFallback(members.length, repTitle), bullets: [], status: 'done' };
    }
    return this.streamSummarize({ kind: 'higher', children, siblings }, key, repTitle, myRun);
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
      // Any event means the model responded — it is warm, so drop the notice.
      this.markFirstToken();
      if (evt.done) {
        // Remember which model produced the summaries (shown in the info panel).
        if (evt.model) this.lastModel = evt.model;
        const parsed = this.parseStream(text);
        final = {
          title: evt.title || repTitle,
          summary: evt.summary ?? parsed.summary,
          bullets: evt.bullets ?? parsed.bullets,
          status: 'done',
        };
        return;
      }
      if (evt.delta) {
        text += evt.delta;
        if (myRun === this.runId) this.set(key, { ...this.parseStream(text), status: 'running' });
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

    return final ?? { title: repTitle, summary: text || this.localFallback(0, repTitle), bullets: [], status: 'done' };
  }

  /** Live cosmetic parse mirroring the backend contract: the prose block (first
   *  non-empty line = title, the rest = summary) optionally followed by a `###`
   *  separator and up to 3 note-style bullet phrases (leading markers stripped). */
  private parseStream(text: string): { title: string; summary: string; bullets: string[] } {
    const sep = text.indexOf('###');
    const head = sep === -1 ? text : text.slice(0, sep);
    const tail = sep === -1 ? '' : text.slice(sep + 3);

    const lines = head.split('\n');
    const i = lines.findIndex(l => l.trim());
    const title = i === -1 ? '' : lines[i].trim();
    const summary = i === -1 ? '' : lines.slice(i + 1).join('\n').trim();

    const bullets = tail
      .split('\n')
      .map(l => l.replace(/^\s*(?:[-*•‣]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return { title, summary, bullets };
  }
}
