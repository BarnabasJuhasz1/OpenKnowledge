import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { OkGraphStateService, PlacedNode } from '../../core/services/okgraph-state.service';
import { ClusterSummaryService, ClusterSummary } from '../../core/services/cluster-summary.service';
import { getCommunitiesAtLevel, louvain } from '../citgraph/louvain';
import { Paper } from '../../core/models/paper.model';
import { citNodeToPaper, repScore } from './cit-node';
import { clusterColor, lighten, withAlpha, blendColors, MISC_COLOR } from './community-colors';
import { edgePath as buildEdgePath, LayoutEdge, TOP_PADDING, orderLanesByConnectivity } from './graph-layout';
import { getArchetypeIcon } from '../../shared/utils/archetype-icons';
import { SearchStateService, paperId } from '../../core/services/search-state.service';
import { CitGraphService, CitGraphNode, CitGraphEdge } from '../../core/services/citgraph.service';
import { DemoModeService } from '../../core/services/demo-mode.service';
import { NotificationService } from '../../core/services/notification.service';
import { parseQuery } from '../../shared/utils/query-parser';
import { matchesNodeKeywords } from '../../shared/utils/keyword-match';
import { ProjectContextService } from '../../core/services/project-context.service';
import { ProjectGraphSettingsService } from '../../core/services/project-graph-settings.service';
import { BookshelfService, BookshelfItem } from '../../core/services/bookshelf.service';

interface Blob {
  topCluster: number;
  x: number;
  y: number;
  path: string;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
  color: string;
  isMisc: boolean;
  label: string;
}

/** A positioned node on the canvas. */
interface RenderNode {
  id: string;
  paper: Paper;
  x: number;
  y: number;
  letter: string;
  color: string;       // cluster colour
  colorStrong: string; // higher-contrast variant for highlights
  star: 'gold' | 'silver' | null; // gold = top 1% ok-score, silver = top 5%, null = neither
  rings: number[];     // radii of inner rings (one per representative level); [] for a leaf
}

/** A merged-blob connector between two highest-level cluster blobs whose
 *  sub-clusters (one level below the current view) are connected. */
interface Bridge {
  key: string;         // unordered top-cluster pair key
  path: string;        // ribbon path joining the two blobs
  color: string;       // blended colour of the two clusters
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  colorStart: string;
  colorEnd: string;
}

interface ExpandPopup {
  nodeId: string;
  direction: 'past' | 'future';
  candidates: PlacedNode[];
  x: number;
  y: number;
}

const YEAR_GAP = 180;
const LEFT_PADDING = 80;
const LANE_NODE_VGAP = 64;     // vertical gap between stacked nodes in one lane
const LANE_MIN_HEIGHT = 130;
const LANE_PAD = 40;           // extra vertical breathing room per lane
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

@Component({
  selector: 'app-ok-graph',
  standalone: true,
  imports: [DecimalPipe, FormsModule],
  templateUrl: './okgraph.component.html',
  styleUrl: './okgraph.component.scss',
})
export class OkGraphComponent implements OnInit {
  readonly state = inject(OkGraphStateService);
  readonly summaries = inject(ClusterSummaryService);
  private readonly searchState = inject(SearchStateService);
  private readonly citgraphSvc = inject(CitGraphService);
  private readonly demo = inject(DemoModeService);
  private readonly notify = inject(NotificationService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly graphStore = inject(ProjectGraphSettingsService);
  private readonly router = inject(Router);
  private readonly bookshelf = inject(BookshelfService);

  // Setup options
  readonly useOnlySelected = signal(true);
  readonly keywordFiltering = signal(false);
  readonly savedItems = signal<BookshelfItem[]>([]);
  readonly activeSeedSourceTab = signal<'selected' | 'library'>('selected');

  ngOnInit(): void {
    this.loadBookshelf();
  }

  loadBookshelf(): void {
    this.bookshelf.list().subscribe({
      next: (items) => this.savedItems.set(items),
    });
  }

  toggleSeed(paper: Paper): void {
    const id = paperId(paper);
    if (this.searchState.graphPaperIds().has(id)) {
      this.searchState.removeFromGraph(id);
    } else {
      this.searchState.addToGraph(paper);
    }
  }

  isSeedSelected(paper: Paper): boolean {
    return this.searchState.isInGraph(paper);
  }

  // Exploration states
  readonly explorationLoading = signal(false);
  readonly explorationError = signal<string | null>(null);

  // The exploration direction the user has picked (null until one is selected).
  // Picking a direction only highlights the button; the actual exploration is
  // kicked off separately by the "Explore" CTA.
  readonly selectedDirection = signal<'past' | 'both' | 'future' | null>(null);

  /** Pick (or toggle off) an exploration direction. */
  selectDirection(direction: 'past' | 'both' | 'future'): void {
    this.selectedDirection.update(cur => (cur === direction ? null : direction));
  }

  /** True once the user can proceed: a direction is chosen and seeds exist. */
  readonly canExplore = computed(() => this.selectedDirection() !== null && this.hasSourcePapers());

  onExplore(): void {
    const dir = this.selectedDirection();
    if (!dir) return;
    this.exploreSurrounding(dir);
  }

  // Selected papers from graph selection list
  readonly selectedPapers = computed(() => {
    const ids = this.searchState.graphPaperIds();
    const all = this.searchState.allScoredPapers();
    const external = this.searchState.externalGraphPapers();
    const saved = this.savedItems()
      .map(item => item.paper)
      .filter((p): p is Paper => !!p);
    const idMap = new Map(all.map(p => [paperId(p), p]));
    for (const [id, p] of external) idMap.set(id, p);
    for (const p of saved) idMap.set(paperId(p), p);
    const result: Paper[] = [];
    for (const id of ids) {
      const p = idMap.get(id);
      if (p) result.push(p);
    }
    return result;
  });

  // Count of all retrieved papers
  readonly retrievedPapersCount = computed(() => {
    return this.searchState.filteredPapers().length;
  });

  // Search query text
  readonly currentQueryText = computed(() => {
    return this.searchState.rawQuery() || 'None';
  });

  // Determines whether we have valid papers to explore
  readonly hasSourcePapers = computed(() => {
    if (this.useOnlySelected()) {
      return this.selectedPapers().length > 0;
    }
    return this.retrievedPapersCount() > 0;
  });

  paperId(paper: Paper): string {
    return paperId(paper);
  }

  removePaper(paper: Paper): void {
    this.searchState.removeFromGraph(paperId(paper));
  }

  exploreSurrounding(direction: 'past' | 'future' | 'both'): void {
    const seeds = this.useOnlySelected() ? this.selectedPapers() : this.searchState.filteredPapers();
    if (!seeds.length) {
      this.notify.show('No seed papers available to build from.');
      return;
    }

    this.explorationLoading.set(true);
    this.explorationError.set(null);

    const seedIds = seeds.map(p => paperId(p));
    const keywords = parseQuery(this.searchState.rawQuery());

    const projectId = this.projectContext.activeProjectId();
    const settings = this.graphStore.load(projectId);
    const kHops = settings.kHops;
    const maxPerHop = settings.maxPerHop !== null ? settings.maxPerHop : 100000;
    const resolution = settings.resolution;

    if (!this.useOnlySelected()) {
      // Build citation graph using only the retrieved papers on the client side
      const nodes: CitGraphNode[] = seeds.map(p => ({
        paper_id: paperId(p),
        doi: p.doi,
        arxiv_id: p.arxiv_id,
        title: p.title,
        abstract: p.abstract,
        year: p.year,
        citation_count: p.citation_count,
        reference_count: p.reference_count,
        authors: p.authors.map(a => a.name),
        journal: p.journal,
        is_open_access: p.is_open_access,
        pdf_url: p.pdf_url,
        fields_of_study: p.fields_of_study || [],
        hop: 0,
        predicted_main_archetype: p.predicted_main_archetype ?? null,
        predicted_second_tier_archetype: p.predicted_second_tier_archetype ?? null,
      }));

      const identifierToId = new Map<string, string>();
      for (const p of seeds) {
        const pId = paperId(p);
        if (p.doi) identifierToId.set(p.doi.toLowerCase(), pId);
        if (p.arxiv_id) identifierToId.set(p.arxiv_id.toLowerCase(), pId);
        if (p.semantic_scholar_id) identifierToId.set(p.semantic_scholar_id.toLowerCase(), pId);
        if (p.openalex_id) identifierToId.set(p.openalex_id.toLowerCase(), pId);
        if (p.pubmed_id) identifierToId.set(p.pubmed_id.toLowerCase(), pId);
      }

      const edgeSeen = new Set<string>();
      const edges: CitGraphEdge[] = [];
      for (const p of seeds) {
        const sourceId = paperId(p);
        for (const ref of (p.references ?? [])) {
          const targetId = identifierToId.get(ref.toLowerCase());
          if (targetId && targetId !== sourceId) {
            const key = `${sourceId} ${targetId}`;
            if (!edgeSeen.has(key)) {
              edgeSeen.add(key);
              edges.push({ source: sourceId, target: targetId });
            }
          }
        }
        for (const ref of (p.referenced_by ?? [])) {
          const targetId = identifierToId.get(ref.toLowerCase());
          if (targetId && targetId !== sourceId) {
            const key = `${targetId} ${sourceId}`;
            if (!edgeSeen.has(key)) {
              edgeSeen.add(key);
              edges.push({ source: targetId, target: sourceId });
            }
          }
        }
      }

      let finalNodes = nodes;
      let finalEdges = edges;
      const hasKeywords = keywords.length > 0;
      if (this.keywordFiltering() && hasKeywords) {
        finalNodes = nodes.filter(
          n => matchesNodeKeywords(n, keywords)
        );
        const kept = new Set(finalNodes.map(n => n.paper_id));
        finalEdges = edges.filter(e => kept.has(e.source) && kept.has(e.target));
      }

      const indexOf = new Map(finalNodes.map((n, i) => [n.paper_id, i]));
      const mappedEdges = finalEdges
        .map(e => ({ source: indexOf.get(e.source) ?? -1, target: indexOf.get(e.target) ?? -1 }))
        .filter(e => e.source >= 0 && e.target >= 0);

      const louvainResult = louvain(finalNodes.length, mappedEdges, {
        resolution: resolution,
        maxLevels: 10,
      });

      this.state.setHierarchy({
        nodes: finalNodes,
        louvain: louvainResult,
        edges: finalEdges,
        resolution: resolution,
        maxLevels: 10,
        keywords,
        seedId: '',
        prefiltered: this.keywordFiltering() && hasKeywords,
        initialSeedIds: [],
      });

      this.explorationLoading.set(false);
      this.notify.show(`Successfully built surrounding graph with ${finalNodes.length} nodes!`);
      return;
    }

    const req = this.demo.enabled()
      ? this.citgraphSvc.exploreDemo({
          paper_ids: seedIds,
          direction,
          include_non_matching: !this.keywordFiltering(),
          keywords,
          k: kHops,
          max_per_hop: maxPerHop
        })
      : this.citgraphSvc.explore({
          paper_ids: seedIds,
          direction,
          include_non_matching: !this.keywordFiltering(),
          keywords,
          k: kHops,
          max_per_hop: maxPerHop
        });

    req.subscribe({
      next: (res) => {
        const baseNodes = res.nodes;
        const edges = res.edges;

        if (!baseNodes.length) {
          this.explorationLoading.set(false);
          this.explorationError.set('No surrounding papers found matching your configuration.');
          return;
        }

        // Louvain re-indexing
        const indexOf = new Map(baseNodes.map((n, i) => [n.paper_id, i]));
        const mappedEdges = edges
          .map(e => ({
            source: indexOf.get(e.source) ?? -1,
            target: indexOf.get(e.target) ?? -1
          }))
          .filter(e => e.source >= 0 && e.target >= 0);

        const louvainResult = louvain(baseNodes.length, mappedEdges, {
          resolution: resolution,
          maxLevels: 10,
        });

        this.state.setHierarchy({
          nodes: baseNodes,
          louvain: louvainResult,
          edges: edges,
          resolution: resolution,
          maxLevels: 10,
          keywords,
          seedId: res.seed_id || (baseNodes[0]?.paper_id ?? ''),
          prefiltered: this.keywordFiltering() && keywords.length > 0,
          initialSeedIds: seedIds,
        });

        this.explorationLoading.set(false);
        this.notify.show(`Successfully built surrounding graph with ${baseNodes.length} nodes!`);
      },
      error: (err) => {
        this.explorationLoading.set(false);
        this.explorationError.set(err.error?.detail || err.message || 'An error occurred while exploring literature.');
        this.notify.show('Failed to build surrounding graph');
      }
    });
  }

  getArchetypeIcon(archetype?: string | null): string {
    return getArchetypeIcon(archetype);
  }

  readonly TOP_PADDING = TOP_PADDING;
  readonly selectedNodeId = signal<string | null>(null);
  // Highest-level cluster (topCluster) the user has selected, or null.
  readonly selectedClusterId = signal<number | null>(null);
  readonly hoveredNodeId = signal<string | null>(null);
  readonly panelCollapsed = signal(false);
  readonly zoom = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly expandPopup = signal<ExpandPopup | null>(null);
  readonly panning = signal(false);

  // Settings panel.
  readonly settingsOpen = signal(false);
  // Star-marker visibility (icons only; nodes stay on the canvas).
  readonly showGoldStars = signal(true);
  readonly showSilverStars = signal(true);
  readonly showSeedMarkers = signal(true);
  // Node filters: restrict the canvas to a star tier (re-lays out when on).
  readonly onlyGoldNodes = signal(false);
  readonly onlySilverNodes = signal(false);
  readonly blobbyShapes = signal(true);
  // Merge the blobs of related top-level clusters (connected one level below the
  // current view) by drawing a blended bridge between them.
  readonly blobMerging = signal(true);

  // Transparency settings (0% to 100% visibility/opacity, default 50%).
  readonly bridgeTransparency = signal<number>(50);
  readonly linkTransparency = signal<number>(50);

  toggleSettings(): void { this.settingsOpen.update(v => !v); }
  closeSettings(): void { this.settingsOpen.set(false); }

  viewClusters(): void {
    const projectId = this.projectContext.activeProjectId();
    this.router.navigate(['/dashboard', projectId, 'graph', 'clustering']);
  }

  isSeedNode(node: RenderNode): boolean {
    return this.state.initialSeedIds().has(paperId(node.paper));
  }

  /**
   * Gold / silver ok-score thresholds over ALL papers in the graph (the active
   * base-node set, which already reflects the keyword filter) — not just the
   * placed/visible nodes. Gold = top 1%, silver = top 5%.
   */
  private readonly scoreThresholds = computed(() => {
    const base = this.state.nodes();
    const n = base.length;
    if (!n) return { gold: Infinity, silver: Infinity };
    const scores = base.map(b => repScore(b)).sort((a, b) => b - a);
    const at = (frac: number) => scores[Math.min(n - 1, Math.max(0, Math.ceil(n * frac) - 1))];
    return { gold: at(0.01), silver: at(0.05) };
  });

  private starFor(score: number): RenderNode['star'] {
    const th = this.scoreThresholds();
    if (score >= th.gold) return 'gold';
    if (score >= th.silver) return 'silver';
    return null;
  }

  /** Concentric-ring radii for a representative at hierarchy level L. A leaf
   *  (L < 0) gets none (single circle); level 0 → 1 ring (2 circles), +1 per
   *  level. Gap scales so the rings always fit inside the r=22 node. */
  private ringsForLevel(level: number): number[] {
    const inner = level >= 0 ? level + 1 : 0;
    if (inner <= 0) return [];
    const gap = Math.min(4.5, 16 / inner);
    return Array.from({ length: inner }, (_, k) => +(22 - (k + 1) * gap).toFixed(2));
  }

  /** Whether a node of the given star tier survives the active node filters. */
  private passesTierFilter(star: RenderNode['star']): boolean {
    const g = this.onlyGoldNodes(), s = this.onlySilverNodes();
    if (!g && !s) return true;          // no tier filter active → show all
    return (g && star === 'gold') || (s && star === 'silver');
  }

  private static readonly ZOOM_MIN = 0.3;
  private static readonly ZOOM_MAX = 3;
  private static readonly ZOOM_STEP = 0.15;
  private static readonly AXIS_HEIGHT = 40;

  readonly AXIS_HEIGHT = OkGraphComponent.AXIS_HEIGHT;

  /** Transform applied to the graph content layer (pan + zoom). */
  readonly contentTransform = computed(
    () => `translate(${this.panX()}, ${this.panY()}) scale(${this.zoom()})`,
  );

  /** Screen-space x of a world x (for the sticky year axis). */
  axisX(worldX: number): number {
    return this.panX() + worldX * this.zoom();
  }

  // Drag-to-pan bookkeeping.
  private dragging = false;
  private didPan = false;        // set once a drag moves past a small threshold
  private dragStartX = 0;
  private dragStartY = 0;
  private panStartX = 0;
  private panStartY = 0;

  // Placed nodes / links live in the (persistent) OkGraphStateService so
  // exploration survives navigating away from and back to the sub-tab.

  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private expandClickTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // --- hierarchy helpers -----------------------------------------------------

  private readonly baseNodes = computed(() => this.state.nodes());
  private readonly levels = computed(() => this.state.louvain()?.levels ?? []);
  private readonly topLevel = computed(() => this.levels().length - 1);

  /** Highest-level cluster id that holds the disconnected "Miscellaneous" group,
   *  or null when the graph has none. `louvain().miscCommunity` is the group's
   *  level-0 community id; compose it up through the hierarchy (it never merges)
   *  to get the top-level lane/blob it lands in. */
  private readonly miscTopCluster = computed<number | null>(() => {
    const lv = this.state.louvain();
    if (!lv || lv.miscCommunity == null) return null;
    const levels = lv.levels;
    let c = lv.miscCommunity; // a level-0 community id
    for (let l = 1; l < levels.length; l++) c = levels[l][c];
    return c;
  });

  /** Cluster colour, with the Miscellaneous cluster forced to neutral grey. */
  private clusterColorFor(topCluster: number): string {
    return topCluster === this.miscTopCluster() ? MISC_COLOR : clusterColor(topCluster);
  }

  /** Memoised community assignment per hierarchy level (recreated per dataset). */
  private readonly communitiesAtLevel = computed(() => {
    const levels = this.levels();
    const n = this.baseNodes().length;
    const cache = new Map<number, number[]>();
    return (level: number): number[] => {
      if (level < 0) return Array.from({ length: n }, (_, i) => i); // leaf: each its own
      let c = cache.get(level);
      if (!c) { c = getCommunitiesAtLevel(levels, n, level); cache.set(level, c); }
      return c;
    };
  });

  constructor() {
    // Seed the top-level representatives once per dataset. setHierarchy() clears
    // placed[], so a fresh send re-seeds; returning to the tab with existing
    // placed nodes keeps them (they persist in the service).
    effect(() => {
      const lv = this.state.louvain();
      if (lv && this.state.placed().length === 0) {
        this.seedTopLevel();
      }
    }, { allowSignalWrites: true });
  }

  private repIndexOfCluster(level: number, community: number): number {
    if (level < 0) return community; // leaf cluster == a single base node
    const comm = this.communitiesAtLevel()(level);
    const nodes = this.baseNodes();
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < comm.length; i++) {
      if (comm[i] !== community) continue;
      const s = repScore(nodes[i]);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
  }

  private clusterSize(level: number, community: number): number {
    if (level < 0) return 1;
    const comm = this.communitiesAtLevel()(level);
    let n = 0;
    for (const c of comm) if (c === community) n++;
    return n;
  }

  private buildPlaced(level: number, community: number, repIndex: number): PlacedNode {
    const node = this.baseNodes()[repIndex];
    const top = this.topLevel();
    return {
      id: node.paper_id,
      repIndex,
      level,
      community,
      topCluster: top >= 0 ? this.communitiesAtLevel()(top)[repIndex] : 0,
      paper: citNodeToPaper(node, repScore(node)),
      clusterSize: this.clusterSize(level, community),
    };
  }

  private seedTopLevel(): void {
    this.selectedNodeId.set(null);
    this.selectedClusterId.set(null);
    this.expandPopup.set(null);
    const levels = this.levels();
    if (!levels.length || !this.baseNodes().length) {
      this.state.placed.set([]); this.state.links.set([]); return;
    }
    const topLevel = levels.length - 1;
    const comm = this.communitiesAtLevel()(topLevel);
    const seen = new Set<number>();
    const placed: PlacedNode[] = [];
    for (const c of comm) {
      if (seen.has(c)) continue;
      seen.add(c);
      const rep = this.repIndexOfCluster(topLevel, c);
      if (rep >= 0) placed.push(this.buildPlaced(topLevel, c, rep));
    }
    this.state.placed.set(placed);
    this.state.links.set([]);
  }

  /**
   * Recommendations for a node: the representatives of the OTHER sub-clusters
   * one level finer than the cluster the node currently represents.
   *
   * A (foundational) paper can be the representative of nested clusters across
   * several levels, so we scan from the node's level downward and return the
   * first level that still has un-placed sibling representatives. Repeated
   * expansion therefore drills the node through its own nested cluster chain:
   * first the k-1 siblings at its level, then — once those are placed — the
   * siblings one level deeper, and so on. At the leaf level the siblings are the
   * other papers of its level-0 community.
   */
  private siblingRecommendations(node: PlacedNode): PlacedNode[] {
    const r = node.repIndex;
    if (r < 0) return [];
    const placedIds = new Set(this.state.placed().map(p => p.id));

    for (let d = node.level; d >= 0; d--) {
      const commD = this.communitiesAtLevel()(d);
      const cD = commD[r];                  // the cluster r belongs to at level d
      const cands: PlacedNode[] = [];

      if (d >= 1) {
        const childComm = this.communitiesAtLevel()(d - 1);
        const subs = new Set<number>();
        for (let i = 0; i < commD.length; i++) {
          if (commD[i] === cD) subs.add(childComm[i]);
        }
        for (const c of subs) {
          const rep = this.repIndexOfCluster(d - 1, c);
          if (rep < 0 || rep === r) continue;   // skip the node's own sub-cluster
          const cand = this.buildPlaced(d - 1, c, rep);
          if (!placedIds.has(cand.id)) cands.push(cand);
        }
      } else { // d === 0 → leaf papers of this level-0 community
        for (let i = 0; i < commD.length; i++) {
          if (commD[i] !== cD || i === r) continue;
          const cand = this.buildPlaced(-1, i, i);
          if (!placedIds.has(cand.id)) cands.push(cand);
        }
      }

      if (cands.length) return cands;  // first (coarsest) level with new siblings
    }
    return [];
  }

  private splitByTime(node: PlacedNode, dir: 'past' | 'future'): PlacedNode[] {
    const ny = node.paper.year;
    const cands = this.siblingRecommendations(node).filter(c => c.paper.year != null);
    const list = dir === 'past'
      ? cands.filter(c => ny != null && c.paper.year! < ny)
      : cands.filter(c => ny == null || c.paper.year! >= ny);
    return list.sort((a, b) => (b.paper.ok_score ?? 0) - (a.paper.ok_score ?? 0));
  }

  private addCandidate(parent: PlacedNode, cand: PlacedNode): void {
    this.state.placed.update(p => [...p, cand]);
    this.state.links.update(l => [...l, { fromId: parent.id, toId: cand.id }]);
  }

  // --- swimlane layout -------------------------------------------------------
  // One horizontal lane per highest-level cluster; x is by year, y is the node's
  // lane (stacked within the lane when several share a lane + year).

  private readonly placedById = computed(() => new Map(this.state.placed().map(p => [p.id, p])));

  private readonly laneLayout = computed(() => {
    const levels = this.levels();
    // Drop yearless nodes, then apply the per-tier node filter so the layout
    // (lanes, year columns, blobs, edges) is recomputed as if the filtered-out
    // nodes were removed entirely.
    const placed = this.state.placed()
      .filter(p => p.paper.year != null)
      .filter(p => this.passesTierFilter(this.starFor(p.paper.ok_score ?? 0)));
    const empty = {
      nodes: [] as RenderNode[], edges: [] as LayoutEdge[],
      yearColumns: [] as { year: number; x: number }[],
      dividers: [] as { x: number }[], laneLines: [] as { y: number }[],
      blobs: [] as Blob[], bridges: [] as Bridge[],
      width: 400, height: 300,
    };
    if (!levels.length || placed.length === 0) return empty;

    const top = levels.length - 1;
    const topComm = this.communitiesAtLevel()(top);
    const misc = this.miscTopCluster();

    // Cluster size (membership over all base nodes) per highest-level cluster.
    const sizeOf = new Map<number, number>();
    for (const c of topComm) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);

    // Cluster-connection weights: number of citation edges joining two *different*
    // top clusters (Miscellaneous excluded, exactly as the merge bridges are
    // derived). Drives the connectivity-aware lane ordering below.
    const idxOf = new Map(this.baseNodes().map((n, i) => [n.paper_id, i]));
    const pairWeight = new Map<string, number>();
    for (const e of (this.state.rawGraph()?.edges ?? [])) {
      const u = idxOf.get(e.source);
      const v = idxOf.get(e.target);
      if (u == null || v == null) continue;
      const tu = topComm[u], tv = topComm[v];
      if (tu === tv) continue;
      if (tu === misc || tv === misc) continue;
      const key = tu < tv ? `${tu}|${tv}` : `${tv}|${tu}`;
      pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
    }

    // Lanes: every highest-level cluster, ordered to minimise bridge overlap —
    // most-connected cluster centred, single-link clusters next to their partner.
    const laneClusters = orderLanesByConnectivity(
      [...sizeOf.keys()], pairWeight, sizeOf, misc,
    );
    const laneIndex = new Map<number, number>();
    laneClusters.forEach((c, i) => laneIndex.set(c, i));
    const numLanes = laneClusters.length;

    // Year columns (x).
    const years = [...new Set(placed.map(p => p.paper.year!))].sort((a, b) => a - b);
    const yearX = new Map<number, number>();
    years.forEach((y, i) => yearX.set(y, LEFT_PADDING + i * YEAR_GAP));

    // Group by (lane, year) to size lanes and stack within a cell.
    const cells = new Map<string, PlacedNode[]>();
    let maxCell = 1;
    for (const p of placed) {
      const lane = laneIndex.get(p.topCluster) ?? 0;
      const key = `${lane}|${p.paper.year}`;
      let arr = cells.get(key);
      if (!arr) { arr = []; cells.set(key, arr); }
      arr.push(p);
      if (arr.length > maxCell) maxCell = arr.length;
    }
    const laneHeight = Math.max(LANE_MIN_HEIGHT, maxCell * LANE_NODE_VGAP + LANE_PAD);

    // Letters by placement order (stable as nodes are added).
    const letterOf = new Map<string, string>();
    placed.forEach((p, i) => letterOf.set(p.id, i < LETTERS.length ? LETTERS[i] : `${i + 1}`));

    const nodes: RenderNode[] = [];
    const boxes = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const [key, members] of cells) {
      const lane = +key.split('|')[0];
      const laneCenter = TOP_PADDING + lane * laneHeight + laneHeight / 2;
      members.sort((a, b) => (b.paper.ok_score ?? 0) - (a.paper.ok_score ?? 0));
      const k = members.length;
      members.forEach((p, j) => {
        const x = yearX.get(p.paper.year!)!;
        const y = laneCenter + (j - (k - 1) / 2) * LANE_NODE_VGAP;
        const color = this.clusterColorFor(p.topCluster);
        nodes.push({
          id: p.id, paper: p.paper, x, y,
          letter: letterOf.get(p.id) ?? '?',
          color, colorStrong: lighten(color),
          star: this.starFor(p.paper.ok_score ?? 0),
          rings: this.ringsForLevel(p.level),
        });
        const b = boxes.get(p.topCluster);
        if (!b) boxes.set(p.topCluster, { minX: x, maxX: x, minY: y, maxY: y });
        else {
          b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
          b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
        }
      });
    }

    // One coloured blob per highest-level cluster, around its representatives.
    const PAD_X = 38, PAD_TOP = 40, PAD_BOTTOM = 50;
    const blobs: Blob[] = [];

    // Group placed nodes by topCluster to easily find their years.
    const clusterNodesMap = new Map<number, PlacedNode[]>();
    for (const p of placed) {
      let arr = clusterNodesMap.get(p.topCluster);
      if (!arr) {
        arr = [];
        clusterNodesMap.set(p.topCluster, arr);
      }
      arr.push(p);
    }

    for (const [topCluster, members] of clusterNodesMap) {
      const yearsInCluster = members.map(m => m.paper.year!);
      const minYear = Math.min(...yearsInCluster);
      const maxYear = Math.max(...yearsInCluster);

      const clusterYears = years.filter(y => y >= minYear && y <= maxYear);

      const lane = laneIndex.get(topCluster) ?? 0;
      const laneCenter = TOP_PADDING + lane * laneHeight + laneHeight / 2;

      const points: { x: number; topY: number; bottomY: number }[] = [];
      for (const y of clusterYears) {
        const x = yearX.get(y)!;
        const cellMembers = cells.get(`${lane}|${y}`);
        const k = cellMembers ? cellMembers.length : 0;

        // If there are no papers in this cluster for this year, treat it as 1 paper height
        // to maintain a continuous lane connection.
        const effectiveK = k > 0 ? k : 1;

        const minY_node = laneCenter - ((effectiveK - 1) / 2) * LANE_NODE_VGAP;
        const maxY_node = laneCenter + ((effectiveK - 1) / 2) * LANE_NODE_VGAP;

        const topY = minY_node - PAD_TOP;
        const bottomY = maxY_node + PAD_BOTTOM;

        points.push({ x, topY, bottomY });
      }

      // Now build the SVG path.
      let path = '';
      if (points.length > 0) {
        const n = points.length - 1;
        const dx = 70; // horizontal control point offset for smooth S-curves
        const capDx = PAD_X * 1.33; // control point offset for rounded end caps

        path = `M ${points[0].x} ${points[0].topY}`;

        // Top edge curve
        for (let i = 0; i < n; i++) {
          path += ` C ${points[i].x + dx} ${points[i].topY}, ${points[i+1].x - dx} ${points[i+1].topY}, ${points[i+1].x} ${points[i+1].topY}`;
        }

        // Right cap curve
        path += ` C ${points[n].x + capDx} ${points[n].topY}, ${points[n].x + capDx} ${points[n].bottomY}, ${points[n].x} ${points[n].bottomY}`;

        // Bottom edge curve
        for (let i = n; i > 0; i--) {
          path += ` C ${points[i].x - dx} ${points[i].bottomY}, ${points[i-1].x + dx} ${points[i-1].bottomY}, ${points[i-1].x} ${points[i-1].bottomY}`;
        }

        // Left cap curve
        path += ` C ${points[0].x - capDx} ${points[0].bottomY}, ${points[0].x - capDx} ${points[0].topY}, ${points[0].x} ${points[0].topY}`;

        path += ' Z';
      }

      const b = boxes.get(topCluster);
      const rectX = b ? b.minX - PAD_X : points[0].x - PAD_X;
      const rectY = b ? b.minY - PAD_TOP : points[0].topY;
      const rectW = b ? (b.maxX - b.minX) + 2 * PAD_X : 2 * PAD_X;
      const rectH = b ? (b.maxY - b.minY) + PAD_TOP + PAD_BOTTOM : points[0].bottomY - points[0].topY;

      const isMisc = topCluster === misc;
      blobs.push({
        topCluster,
        x: points[0].x - PAD_X,
        y: points[0].topY,
        path,
        rectX,
        rectY,
        rectW,
        rectH,
        color: this.clusterColorFor(topCluster),
        isMisc,
        label: isMisc ? 'Miscellaneous' : '',
      });
    }

    // Merge bridges: join the blobs of two highest-level clusters when their
    // sub-clusters (one level below this, the highest, view) are connected — i.e.
    // the representative papers of two sub-clusters in different top clusters share
    // a citation edge. The bridge is anchored between those representatives.
    const bridges = this.blobMerging()
      ? this.buildBridges(top, topComm, laneIndex, laneHeight, boxes, nodes, years, yearX)
      : [];

    const dividers: { x: number }[] = [];
    for (let i = 0; i < years.length - 1; i++) {
      dividers.push({ x: (yearX.get(years[i])! + yearX.get(years[i + 1])!) / 2 });
    }

    const laneLines: { y: number }[] = [];
    for (let i = 0; i <= numLanes; i++) laneLines.push({ y: TOP_PADDING + i * laneHeight });

    const width = years.length
      ? yearX.get(years[years.length - 1])! + LEFT_PADDING + 40
      : 400;
    const height = TOP_PADDING + numLanes * laneHeight + 20;

    // Manual links between placed-with-year nodes.
    const known = new Set(placed.map(p => p.id));
    const seen = new Set<string>();
    const edges: LayoutEdge[] = [];
    for (const e of this.state.links()) {
      if (!known.has(e.fromId) || !known.has(e.toId)) continue;
      const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }

    return {
      nodes, edges,
      yearColumns: years.map(y => ({ year: y, x: yearX.get(y)! })),
      dividers, laneLines, blobs, bridges, width, height,
    };
  });

  /**
   * Bridges that merge the blobs of two highest-level clusters. The current view
   * is the top level; we look one level below (`top - 1`) and find pairs of
   * sub-clusters whose representative papers are connected by a citation edge yet
   * sit in *different* top-level clusters. Each such pair yields one translucent
   * ribbon, blended from the two cluster colours, anchored between the two
   * representatives (at their placed nodes when present, else lane geometry) so
   * the two blobs read as merged.
   */
  private buildBridges(
    top: number,
    topComm: number[],
    laneIndex: Map<number, number>,
    laneHeight: number,
    boxes: Map<number, { minX: number; maxX: number; minY: number; maxY: number }>,
    nodes: RenderNode[],
    years: number[],
    yearX: Map<number, number>,
  ): Bridge[] {
    if (top < 1) return [];                 // no level below the top → nothing to merge
    const subLevel = top - 1;
    const baseNodes = this.baseNodes();
    const subComm = this.communitiesAtLevel()(subLevel);
    const idxOf = new Map(baseNodes.map((n, i) => [n.paper_id, i]));
    const misc = this.miscTopCluster();
    const rawEdges = this.state.rawGraph()?.edges ?? [];

    // For each unordered top-cluster pair, track which sub-cluster pair carries
    // the most connecting edges (that pair anchors the bridge).
    const pairs = new Map<string, { sub: Map<string, number>; ta: number; tb: number }>();
    for (const e of rawEdges) {
      const u = idxOf.get(e.source);
      const v = idxOf.get(e.target);
      if (u == null || v == null) continue;
      const tu = topComm[u], tv = topComm[v];
      if (tu === tv) continue;                          // same blob already
      if (tu === misc || tv === misc) continue;         // Miscellaneous never merges
      const su = subComm[u], sv = subComm[v];
      const topKey = tu < tv ? `${tu}|${tv}` : `${tv}|${tu}`;
      const subKey = su < sv ? `${su}|${sv}` : `${sv}|${su}`;
      let rec = pairs.get(topKey);
      if (!rec) { rec = { sub: new Map(), ta: tu, tb: tv }; pairs.set(topKey, rec); }
      rec.sub.set(subKey, (rec.sub.get(subKey) ?? 0) + 1);
    }
    if (!pairs.size) return [];

    const renderPos = new Map(nodes.map(n => [n.id, n]));

    // Map an arbitrary year onto the (index-spaced) year axis.
    const yearToX = (yr: number): number => {
      if (yearX.has(yr)) return yearX.get(yr)!;
      if (!years.length) return LEFT_PADDING;
      if (yr <= years[0]) return yearX.get(years[0])!;
      if (yr >= years[years.length - 1]) return yearX.get(years[years.length - 1])!;
      for (let i = 0; i < years.length - 1; i++) {
        if (yr >= years[i] && yr <= years[i + 1]) {
          const f = (yr - years[i]) / (years[i + 1] - years[i]);
          return yearX.get(years[i])! + f * (yearX.get(years[i + 1])! - yearX.get(years[i])!);
        }
      }
      return yearX.get(years[years.length - 1])!;
    };

    // Anchor point for one sub-cluster: its representative's placed node when it
    // is on the canvas, otherwise its year clamped to the parent blob's x-extent.
    const anchorFor = (subId: number): { x: number; y: number } | null => {
      const rep = this.repIndexOfCluster(subLevel, subId);
      if (rep < 0) return null;
      const repNode = baseNodes[rep];
      const placed = renderPos.get(repNode.paper_id);
      if (placed) return { x: placed.x, y: placed.y };
      const parentTop = topComm[rep];
      const lane = laneIndex.get(parentTop) ?? 0;
      const laneCenter = TOP_PADDING + lane * laneHeight + laneHeight / 2;
      const box = boxes.get(parentTop);
      let x = repNode.year != null ? yearToX(repNode.year)
            : box ? (box.minX + box.maxX) / 2 : LEFT_PADDING;
      if (box) x = Math.min(Math.max(x, box.minX), box.maxX);
      return { x, y: laneCenter };
    };

    const bridges: Bridge[] = [];
    for (const [topKey, rec] of pairs) {
      let bestSub = '', bestCount = -1;
      for (const [sk, c] of rec.sub) if (c > bestCount) { bestCount = c; bestSub = sk; }
      const [sa, sb] = bestSub.split('|').map(Number);
      const repA = this.repIndexOfCluster(subLevel, sa);
      const repB = this.repIndexOfCluster(subLevel, sb);
      if (repA < 0 || repB < 0) continue;
      const topA = topComm[repA];
      const topB = topComm[repB];
      const a = anchorFor(sa);
      const b = anchorFor(sb);
      if (!a || !b) continue;

      const startNode = a.x <= b.x ? a : b;
      const endNode = a.x <= b.x ? b : a;
      const startColor = a.x <= b.x ? this.clusterColorFor(topA) : this.clusterColorFor(topB);
      const endColor = a.x <= b.x ? this.clusterColorFor(topB) : this.clusterColorFor(topA);

      bridges.push({
        key: topKey,
        path: this.ribbonPath(a, b),
        color: blendColors(startColor, endColor),
        x1: startNode.x,
        y1: startNode.y,
        x2: endNode.x,
        y2: endNode.y,
        colorStart: startColor,
        colorEnd: endColor,
      });
    }
    return bridges;
  }

  /** A vertical translucent ribbon (closed bezier) joining two anchor points —
   *  the merge neck between two cluster blobs. */
  private ribbonPath(p0: { x: number; y: number }, p1: { x: number; y: number }): string {
    const hw = 24;                       // half-width of the neck
    const cy = (p0.y + p1.y) / 2;        // shared control-point y for a soft S-curve
    return (
      `M ${p0.x} ${p0.y}` +
      ` C ${p0.x - hw} ${cy}, ${p1.x - hw} ${cy}, ${p1.x} ${p1.y}` +
      ` C ${p1.x + hw} ${cy}, ${p0.x + hw} ${cy}, ${p0.x} ${p0.y}` +
      ' Z'
    );
  }

  readonly nodes = computed(() => this.laneLayout().nodes);
  readonly edges = computed(() => this.laneLayout().edges);
  readonly yearColumns = computed(() => this.laneLayout().yearColumns);
  readonly dividers = computed(() => this.laneLayout().dividers);
  readonly laneLines = computed(() => this.laneLayout().laneLines);
  readonly blobs = computed(() => this.laneLayout().blobs);
  readonly bridges = computed(() => this.laneLayout().bridges);
  readonly svgWidth = computed(() => this.laneLayout().width);
  readonly svgHeight = computed(() => this.laneLayout().height);

  readonly totalClusters = computed(() => this.blobs().length);
  readonly totalPapers = computed(() => {
    const visible = this.nodes().length;
    const total = this.baseNodes().length;
    return `${visible} / ${total}`;
  });
  readonly totalSeeds = computed(() => {
    const visible = this.nodes().filter(n => this.isSeedNode(n)).length;
    const total = this.baseNodes().filter(n => this.state.initialSeedIds().has(n.paper_id)).length;
    return `${visible} / ${total}`;
  });
  readonly totalGoldStars = computed(() => {
    const visible = this.nodes().filter(n => n.star === 'gold').length;
    const total = this.baseNodes().filter(n => this.starFor(repScore(n)) === 'gold').length;
    return `${visible} / ${total}`;
  });
  readonly totalSilverStars = computed(() => {
    const visible = this.nodes().filter(n => n.star === 'silver').length;
    const total = this.baseNodes().filter(n => this.starFor(repScore(n)) === 'silver').length;
    return `${visible} / ${total}`;
  });

  private readonly nodeMap = computed(() => new Map(this.nodes().map(n => [n.id, n])));

  readonly hasContent = computed(() => this.state.hasContent());
  readonly placedCount = computed(() => this.state.placed().length);

  readonly selectedPaper = computed<Paper | null>(() => {
    const id = this.selectedNodeId();
    return id ? this.placedById().get(id)?.paper ?? null : null;
  });

  readonly selectedPlaced = computed<PlacedNode | null>(() => {
    const id = this.selectedNodeId();
    return id ? this.placedById().get(id) ?? null : null;
  });

  readonly selectedLetter = computed<string>(() => {
    const id = this.selectedNodeId();
    return id ? this.nodeMap().get(id)?.letter ?? '' : '';
  });

  /** Cluster display name — matches the Cit-Graph convention. */
  private clusterName(topCluster: number): string {
    return topCluster === this.miscTopCluster() ? 'Miscellaneous' : `Cluster ${topCluster}`;
  }

  /**
   * Details of the currently selected cluster for the top-left popup, or null when
   * nothing is selected or the selected cluster is not currently on the canvas
   * (e.g. it was filtered out). `size` is the cluster's full membership at the top
   * level; `repTitle` is its highest-scoring representative.
   */
  readonly selectedCluster = computed<
    { id: number; name: string; color: string; repTitle: string; size: number; isMisc: boolean } | null
  >(() => {
    const id = this.selectedClusterId();
    if (id === null) return null;
    const blob = this.blobs().find(b => b.topCluster === id);
    if (!blob) return null;
    const top = this.topLevel();
    const repIndex = top >= 0 ? this.repIndexOfCluster(top, id) : -1;
    const repTitle = repIndex >= 0 ? (this.baseNodes()[repIndex]?.title ?? '') : '';
    const size = top >= 0 ? this.clusterSize(top, id) : 0;
    return {
      id,
      name: this.clusterName(id),
      color: blob.color,
      repTitle,
      size,
      isMisc: blob.isMisc,
    };
  });

  isClusterSelected(topCluster: number): boolean {
    return this.selectedClusterId() === topCluster;
  }

  /**
   * AI summary for the selected top-level cluster. The summary service keys by
   * (hierarchyIndex, communityId) over the shared raw graph; the OK-Graph's
   * top-level community ids match it only while the keyword filter is off (the
   * filter re-clusters a subset, producing a different id space). When filtered,
   * we return undefined rather than show a mismatched summary.
   */
  readonly selectedClusterSummary = computed<ClusterSummary | undefined>(() => {
    const id = this.selectedClusterId();
    if (id === null || this.state.filterActive()) return undefined;
    const top = this.topLevel();
    if (top < 0) return undefined;
    return this.summaries.summaryAt(top, id);
  });

  // --- interaction -----------------------------------------------------------

  selectNode(node: RenderNode, event?: MouseEvent): void {
    event?.stopPropagation();
    this.expandPopup.set(null);
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      const topCluster = this.placedById().get(node.id)?.topCluster ?? null;
      this.selectedNodeId.update(cur => {
        if (cur === node.id) {            // toggling the node off → drop its cluster too
          this.selectedClusterId.set(null);
          return null;
        }
        // Selecting a paper selects the cluster it belongs to.
        this.selectedClusterId.set(topCluster);
        return node.id;
      });
    }, 250);
  }

  /** Select a whole cluster by clicking its blob / coloured background. */
  selectCluster(blob: Blob, event: MouseEvent): void {
    event.stopPropagation();
    if (this.didPan) return;             // the click was the tail of a drag-to-pan
    this.expandPopup.set(null);
    this.selectedNodeId.set(null);
    this.selectedClusterId.set(blob.topCluster);
  }

  /** Click on bare canvas background → deselect the cluster (and node) + popups. */
  onBackgroundClick(event: MouseEvent): void {
    if (this.didPan) return;
    const t = event.target as Element;
    if (t.closest('.graph-svg__node') || t.closest('.graph-svg__blob') ||
        t.closest('.zoom-controls') || t.closest('.expand-popup') ||
        t.closest('.graph-settings') || t.closest('.cluster-popup')) {
      return;
    }
    this.selectedClusterId.set(null);
    this.selectedNodeId.set(null);
    this.expandPopup.set(null);
  }

  closeClusterPopup(): void {
    this.selectedClusterId.set(null);
  }

  onNodeDblClick(node: RenderNode, event: MouseEvent): void {
    event.stopPropagation();
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.selectedNodeId.set(node.id);
    const placed = this.placedById().get(node.id);
    if (!placed) return;
    this.selectedClusterId.set(placed.topCluster);
    const past = this.splitByTime(placed, 'past');
    const future = this.splitByTime(placed, 'future');
    if (past.length) this.addCandidate(placed, past[0]);
    if (future.length) this.addCandidate(placed, future[0]);
  }

  onExpandArrowClick(node: RenderNode, direction: 'past' | 'future', event: MouseEvent): void {
    event.stopPropagation();
    const key = `${direction}-${node.id}`;
    const existing = this.expandClickTimers.get(key);
    if (existing) {  // second click → treat as double click: add top candidate
      clearTimeout(existing);
      this.expandClickTimers.delete(key);
      const placed = this.placedById().get(node.id);
      if (placed) {
        const list = this.splitByTime(placed, direction);
        if (list.length) this.addCandidate(placed, list[0]);
      }
      return;
    }
    const timer = setTimeout(() => {
      this.expandClickTimers.delete(key);
      this.selectedNodeId.set(node.id);
      this.showExpandPopup(node, direction);
    }, 250);
    this.expandClickTimers.set(key, timer);
  }

  private showExpandPopup(node: RenderNode, direction: 'past' | 'future'): void {
    const placed = this.placedById().get(node.id);
    if (!placed) return;
    const candidates = this.splitByTime(placed, direction);
    if (!candidates.length) return;
    const offsetX = direction === 'past' ? node.x - 34 : node.x + 34;
    this.expandPopup.set({
      nodeId: node.id,
      direction,
      candidates,
      x: this.panX() + offsetX * this.zoom(),
      y: this.panY() + (node.y + 16) * this.zoom(),
    });
  }

  addFromPopup(cand: PlacedNode): void {
    const popup = this.expandPopup();
    if (!popup) return;
    const parent = this.placedById().get(popup.nodeId);
    if (parent) this.addCandidate(parent, cand);
    this.expandPopup.set(null);
  }

  closeExpandPopup(): void {
    this.expandPopup.set(null);
  }

  canExpandPast(node: RenderNode): boolean {
    const p = this.placedById().get(node.id);
    return !!p && this.splitByTime(p, 'past').length > 0;
  }

  canExpandFuture(node: RenderNode): boolean {
    const p = this.placedById().get(node.id);
    return !!p && this.splitByTime(p, 'future').length > 0;
  }

  showExpandButtons(node: RenderNode): boolean {
    return this.selectedNodeId() === node.id || this.hoveredNodeId() === node.id;
  }

  onNodeEnter(node: RenderNode): void { this.hoveredNodeId.set(node.id); }
  onNodeLeave(): void { this.hoveredNodeId.set(null); }

  removeSelectedNode(): void {
    const id = this.selectedNodeId();
    if (!id) return;
    this.state.placed.update(p => p.filter(n => n.id !== id));
    this.state.links.update(l => l.filter(e => e.fromId !== id && e.toId !== id));
    this.selectedNodeId.set(null);
  }

  clearGraph(): void {
    this.selectedNodeId.set(null);
    this.selectedClusterId.set(null);
    this.expandPopup.set(null);
    this.state.clear();
  }

  // --- rendering helpers -----------------------------------------------------

  isSelected(node: RenderNode): boolean { return this.selectedNodeId() === node.id; }

  isConnected(node: RenderNode): boolean {
    const sel = this.selectedNodeId();
    if (!sel) return false;
    return this.edges().some(
      e => (e.fromId === sel && e.toId === node.id) || (e.toId === sel && e.fromId === node.id),
    );
  }

  isEdgeHighlighted(edge: LayoutEdge): boolean {
    const sel = this.selectedNodeId();
    return !!sel && (edge.fromId === sel || edge.toId === sel);
  }

  isBridgeHighlighted(bridge: Bridge): boolean {
    const sel = this.selectedClusterId();
    if (sel === null) return false;
    const [ta, tb] = bridge.key.split('|').map(Number);
    return ta === sel || tb === sel;
  }

  edgePath(edge: LayoutEdge): string {
    const from = this.nodeMap().get(edge.fromId);
    const to = this.nodeMap().get(edge.toId);
    return from && to ? buildEdgePath(from, to) : '';
  }

  nodeLabel(node: RenderNode): string {
    const t = node.paper.title;
    return t.length > 28 ? t.slice(0, 26) + '…' : t;
  }

  authorLine(paper: Paper): string {
    const a = paper.authors;
    if (!a?.length) return '';
    const names = a.slice(0, 5).map(x => x.name);
    return a.length > 5 ? names.join(', ') + ' et al.' : names.join(', ');
  }

  closePanel(): void { this.selectedNodeId.set(null); }
  togglePanel(): void { this.panelCollapsed.update(v => !v); }

  private lastW = 800;
  private lastH = 500;

  private applyZoom(newZoom: number, cx: number, cy: number): void {
    const z = this.zoom();
    const clamped = Math.min(Math.max(newZoom, OkGraphComponent.ZOOM_MIN), OkGraphComponent.ZOOM_MAX);
    if (clamped === z) return;
    // Keep the world point under the cursor fixed on screen.
    this.panX.set(cx - (cx - this.panX()) * (clamped / z));
    this.panY.set(cy - (cy - this.panY()) * (clamped / z));
    this.zoom.set(clamped);
  }

  /** Plain wheel = zoom in/out, centred on the cursor. */
  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.lastW = rect.width;
    this.lastH = rect.height;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.applyZoom(this.zoom() * factor, event.clientX - rect.left, event.clientY - rect.top);
  }

  onPanStart(event: MouseEvent): void {
    this.didPan = false;
    const t = event.target as Element;
    // Let nodes / arrows / controls handle their own clicks.
    if (t.closest('.graph-svg__node') || t.closest('.zoom-controls') ||
        t.closest('.expand-popup') || t.closest('.graph-settings') ||
        t.closest('.cluster-popup')) {
      return;
    }
    this.expandPopup.set(null);
    this.dragging = true;
    this.panning.set(true);
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.panStartX = this.panX();
    this.panStartY = this.panY();
  }

  onPanMove(event: MouseEvent): void {
    if (!this.dragging) return;
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.didPan = true;
    this.panX.set(this.panStartX + dx);
    this.panY.set(this.panStartY + dy);
  }

  onPanEnd(): void {
    this.dragging = false;
    this.panning.set(false);
  }

  zoomIn(): void { this.applyZoom(this.zoom() * 1.2, this.lastW / 2, this.lastH / 2); }
  zoomOut(): void { this.applyZoom(this.zoom() / 1.2, this.lastW / 2, this.lastH / 2); }
  resetZoom(): void { this.zoom.set(1); this.panX.set(0); this.panY.set(0); }
  get zoomPercent(): number { return Math.round(this.zoom() * 100); }

  // --- cluster-coloured highlighting -----------------------------------------

  nodeFill(node: RenderNode): string {
    if (this.isSelected(node)) return node.color;       // solid, vivid
    if (this.isConnected(node)) return withAlpha(node.color, 0.32);
    return withAlpha(node.color, 0.15);
  }

  nodeStroke(node: RenderNode): string {
    if (this.isSelected(node)) return node.colorStrong; // bright ring
    if (this.isConnected(node)) return node.colorStrong;
    return withAlpha(node.color, 0.6);
  }

  edgeStroke(edge: LayoutEdge): string {
    const from = this.nodeMap().get(edge.fromId);
    const color = from?.color ?? '#94a3b8';
    const strong = from?.colorStrong ?? color;
    if (this.isEdgeHighlighted(edge)) return strong;    // brighter highlight
    if (this.selectedNodeId()) return withAlpha(color, 0.16);
    return withAlpha(color, 0.45);
  }
}
