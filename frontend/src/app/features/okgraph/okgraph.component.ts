import { Component, HostListener, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { OkGraphStateService, PlacedNode } from '../../core/services/okgraph-state.service';
import { ClusterSummaryService, ClusterSummary } from '../../core/services/cluster-summary.service';
import { getCommunitiesAtLevel, louvain } from '../citgraph/louvain';
import { Paper } from '../../core/models/paper.model';
import { citNodeToPaper, repScore } from './cit-node';
import { clusterColor, lighten, withAlpha, blendColors, MISC_COLOR } from './community-colors';
import { edgePath as buildEdgePath, LayoutEdge, TOP_PADDING, NODE_RADIUS, orderLanesByConnectivity } from './graph-layout';
import { yearExpandQueues, middleYears } from './year-expand';
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
  clusterId: number;   // active cluster/lane ID in current view
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

interface TransitionState {
  stage: 'none' | 'fade-out' | 'expand' | 'shift' | 'reveal';
  targetClusterId: number | null;
  rect: { x: number; y: number; w: number; h: number };
  color: string;
}

const YEAR_GAP = 180;
const LEFT_PADDING = 80;
const LANE_NODE_VGAP = 64;     // vertical gap between stacked nodes in one lane
const LANE_MIN_HEIGHT = 220;
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
  readonly transitionState = signal<TransitionState | null>(null);
  readonly innerViewClusterId = signal<number | null>(null);
  // Pins the cluster's representative paper in place when we drill into it. We
  // capture the rep node's world position in the outer view at the moment of
  // entry; the inner-view layout is then translated so that same node lands
  // exactly there (both axes) instead of the whole stack snapping to the top-left.
  // The representative therefore never moves — every other node shifts by that
  // same translation and additionally reshuffles into its subcluster lane, so it
  // moves relative to the fixed representative. `id` is the rep paper id; when it
  // can't be found in the inner layout (e.g. filtered out), the translation falls
  // back to mapping the inner layout's centroid to (x, y). Null outside inner view.
  readonly innerViewAnchor = signal<{ id: string; x: number; y: number } | null>(null);
  readonly innerViewClusterColor = computed(() => {
    const id = this.innerViewClusterId();
    return id === null ? '' : this.clusterColorFor(id);
  });
  readonly innerViewClusterName = computed(() => {
    const id = this.innerViewClusterId();
    return id === null ? '' : this.clusterName(id);
  });
  // Whether the canvas should wear the inner-view tint/frame. Driven off the
  // transition (from the `expand` stage onward) as well as the committed inner
  // view, so the background colour finishes settling BEFORE the layout swaps and
  // the nodes start moving — the background must not change at that moment.
  readonly canvasInnerView = computed(() => {
    if (this.innerViewClusterId() !== null) return true;
    const stage = this.transitionState()?.stage;
    return stage === 'expand' || stage === 'shift' || stage === 'reveal';
  });
  readonly canvasInnerViewColor = computed(() => {
    const id = this.innerViewClusterId();
    if (id !== null) return this.clusterColorFor(id);
    return this.transitionState()?.color ?? '';
  });
  readonly baseNodesFiltered = computed(() => {
    const base = this.baseNodes();
    const T = this.innerViewClusterId();
    if (T === null) return base;
    const top = this.topLevel();
    if (top < 0) return base;
    const topComm = this.communitiesAtLevel()(top);
    return base.filter((_, idx) => topComm[idx] === T);
  });

  readonly selectedNodeId = signal<string | null>(null);
  // Highest-level cluster (topCluster or subcluster ID depending on view) the user has selected, or null.
  readonly selectedClusterId = signal<number | null>(null);
  readonly hoveredNodeId = signal<string | null>(null);
  readonly panelCollapsed = this.state.panelCollapsed;
  readonly zoom = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly expandPopup = signal<ExpandPopup | null>(null);
  readonly panning = signal(false);

  // Year-axis selection: the single year the user has picked on the axis (or
  // null). Selecting a year highlights its vertical lane and reveals the Expand
  // button, which drills the per-cluster year queue (see expandYear()).
  readonly selectedYear = signal<number | null>(null);
  // Year-axis in-between selection: the gap between two non-consecutive year
  // columns the user has picked (or null). Mutually exclusive with selectedYear.
  // Selecting a gap reveals the Expand button, which drills the middle year(s)
  // of the [leftYear, rightYear] range (see expandGap()).
  readonly selectedGap = signal<{ leftYear: number; rightYear: number } | null>(null);
  // Half-width (world units) of the highlighted vertical band around a year.
  readonly YEAR_HIGHLIGHT_HALF = 46;

  // Settings panel.
  readonly settingsOpen = signal(false);
  readonly clearConfirmOpen = signal(false);
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
  // Unified vertical expansion option (make all horizontal lane heights identical).
  readonly unifiedVerticalExpansion = signal(false);
  // When moving inside a cluster, expand the transition overlay as a noisy,
  // organic blob (turbulence-displaced, wobbling edges) instead of a clean
  // rectangle growing to fill the canvas.
  readonly blobTransition = signal(false);
  readonly useInGraphCards = signal(true);
  // When on, cluster cards are not all left-aligned in a vertical column; each is
  // placed just left of its cluster's left-most node, so they stagger
  // horizontally following where each cluster starts.
  readonly staggeredCards = signal(false);
  // Fixed on-graph cluster card height (px). The card never scrolls and never
  // resizes with content; the lane simply centres a card of this size.
  readonly cardHeight = 150;
  // Fixed on-graph cluster card width (px); kept in sync with the foreignObject.
  readonly cardWidth = 300;
  // Default left x for cards when left-aligned (not staggered).
  readonly cardAlignedX = 20;
  // Left edge where the first year column / left-most node sits. With in-graph
  // cards the card occupies x=20..320, so this also sets the gap to the nodes.
  readonly leftPadding = computed(() => this.useInGraphCards() ? 420 : 80);

  // Transparency settings (0% to 100% visibility/opacity, default 50%).
  readonly bridgeTransparency = signal<number>(50);
  readonly linkTransparency = signal<number>(50);
  readonly gridTransparency = signal<number>(50);
  readonly gridOpacity = computed(() => Math.min(1, this.gridTransparency() / 50));
  readonly gridStrokeWidth = computed(() => {
    const val = this.gridTransparency();
    return val <= 50 ? 1 : 1 + (val - 50) / 50;
  });

  toggleSettings(): void { this.settingsOpen.update(v => !v); }
  closeSettings(): void { this.settingsOpen.set(false); }

  requestClearGraph(): void { this.clearConfirmOpen.set(true); }
  cancelClearGraph(): void { this.clearConfirmOpen.set(false); }
  confirmClearGraph(): void {
    this.clearGraph();
    this.clearConfirmOpen.set(false);
  }

  viewClusters(): void {
    if (this.isViewClustersDisabled()) return;
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
  readonly isViewClustersDisabled = computed(() => this.baseNodes().length > 3000);
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

  private clusterColorFor(topCluster: number, isSubcluster = false): string {
    if (isSubcluster) return clusterColor(topCluster);
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

    // Handle auto-collapse/expand of the right-side detail panel on paper selection changes
    effect(() => {
      const selectedId = this.selectedNodeId();
      if (selectedId) {
        // A paper was selected. Automatically open the panel if user hasn't manually collapsed it
        if (untracked(() => this.state.autoOpenEnabled())) {
          this.panelCollapsed.set(false);
        }
      } else {
        // A paper was deselected. Automatically collapse the panel.
        this.panelCollapsed.set(true);
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
    this.selectedYear.set(null);
    this.selectedGap.set(null);
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

  readonly laneLayout = computed(() => {
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
      laneBoxes: [] as any[],
    };
    if (!levels.length || placed.length === 0) return empty;

    const top = levels.length - 1;
    const topComm = this.communitiesAtLevel()(top);
    const misc = this.miscTopCluster();

    const innerId = this.innerViewClusterId();
    const isInner = innerId !== null;
    const currentTopLevel = isInner ? Math.max(0, top - 1) : top;
    const currentComm = this.communitiesAtLevel()(currentTopLevel);

    const placedFiltered = placed
      .filter(p => !isInner || p.topCluster === innerId);

    if (placedFiltered.length === 0) return empty;

    // Cluster size (membership over all base nodes) per highest-level cluster.
    const sizeOf = new Map<number, number>();
    if (!isInner) {
      for (const c of currentComm) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    } else {
      // Inside a cluster, only give a lane (and therefore a card) to subclusters
      // that actually have a node drawn in the graph — i.e. their representative
      // is currently visualized. Subclusters with no placed node are omitted so
      // we don't show empty cards for them.
      const visibleSub = new Set<number>();
      for (const p of placedFiltered) visibleSub.add(currentComm[p.repIndex]);
      for (let i = 0; i < currentComm.length; i++) {
        if (topComm[i] === innerId) {
          const c = currentComm[i];
          if (!visibleSub.has(c)) continue;
          sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
        }
      }
    }

    // Cluster-connection weights: number of citation edges joining two *different*
    // clusters. Drives the connectivity-aware lane ordering below.
    const idxOf = new Map(this.baseNodes().map((n, i) => [n.paper_id, i]));
    const pairWeight = new Map<string, number>();
    for (const e of (this.state.rawGraph()?.edges ?? [])) {
      const u = idxOf.get(e.source);
      const v = idxOf.get(e.target);
      if (u == null || v == null) continue;
      const tu = currentComm[u], tv = currentComm[v];
      if (tu === tv) continue;
      if (!isInner) {
        if (tu === misc || tv === misc) continue;
        const key = tu < tv ? `${tu}|${tv}` : `${tv}|${tu}`;
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
      } else {
        if (topComm[u] === innerId && topComm[v] === innerId) {
          const isMiscU = currentTopLevel === 0 && tu === misc;
          const isMiscV = currentTopLevel === 0 && tv === misc;
          if (isMiscU || isMiscV) continue;
          const key = tu < tv ? `${tu}|${tv}` : `${tv}|${tu}`;
          pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
        }
      }
    }

    // Lanes: ordered to minimise bridge overlap.
    const laneClusters = orderLanesByConnectivity(
      [...sizeOf.keys()], pairWeight, sizeOf, isInner ? null : misc,
    );
    const laneIndex = new Map<number, number>();
    laneClusters.forEach((c, i) => laneIndex.set(c, i));
    const numLanes = laneClusters.length;

    // Year columns (x).
    const leftPad = this.leftPadding();
    const years = [...new Set(placedFiltered.map(p => p.paper.year!))].sort((a, b) => a - b);
    const yearX = new Map<number, number>();
    years.forEach((y, i) => yearX.set(y, leftPad + i * YEAR_GAP));

    // Group by (lane, year) to size lanes and stack within a cell.
    const cells = new Map<string, PlacedNode[]>();
    let maxCell = 1;
    for (const p of placedFiltered) {
      const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
      const lane = laneIndex.get(nodeClusterId) ?? 0;
      const key = `${lane}|${p.paper.year}`;
      let arr = cells.get(key);
      if (!arr) { arr = []; cells.set(key, arr); }
      arr.push(p);
      if (arr.length > maxCell) maxCell = arr.length;
    }

    const maxCellForLane = new Map<number, number>();
    for (let i = 0; i < numLanes; i++) {
      maxCellForLane.set(i, 1);
    }
    for (const [key, arr] of cells.entries()) {
      const lane = +key.split('|')[0];
      const count = arr.length;
      if (count > (maxCellForLane.get(lane) ?? 1)) {
        maxCellForLane.set(lane, count);
      }
    }

    const laneHeights: number[] = [];
    const isUnified = this.unifiedVerticalExpansion();
    for (let i = 0; i < numLanes; i++) {
      const cellCount = isUnified ? maxCell : (maxCellForLane.get(i) ?? 1);
      laneHeights.push(Math.max(LANE_MIN_HEIGHT, cellCount * LANE_NODE_VGAP + LANE_PAD));
    }

    const laneYStart: number[] = [TOP_PADDING];
    for (let i = 1; i <= numLanes; i++) {
      laneYStart.push(laneYStart[i - 1] + laneHeights[i - 1]);
    }
    const laneCenters: number[] = [];
    for (let i = 0; i < numLanes; i++) {
      laneCenters.push(laneYStart[i] + laneHeights[i] / 2);
    }

    // Letters by placement order (stable as nodes are added).
    const letterOf = new Map<string, string>();
    placed.forEach((p, i) => letterOf.set(p.id, i < LETTERS.length ? LETTERS[i] : `${i + 1}`));

    const nodes: RenderNode[] = [];
    const boxes = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const [key, members] of cells) {
      const lane = +key.split('|')[0];
      const laneCenter = laneCenters[lane];
      members.sort((a, b) => (b.paper.ok_score ?? 0) - (a.paper.ok_score ?? 0));
      const k = members.length;
      members.forEach((p, j) => {
        const x = yearX.get(p.paper.year!)!;
        const y = laneCenter + (j - (k - 1) / 2) * LANE_NODE_VGAP;
        const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
        const color = this.clusterColorFor(nodeClusterId, isInner);
        nodes.push({
          id: p.id, paper: p.paper, x, y,
          letter: letterOf.get(p.id) ?? '?',
          color, colorStrong: lighten(color),
          star: this.starFor(p.paper.ok_score ?? 0),
          rings: this.ringsForLevel(p.level),
          clusterId: nodeClusterId,
        });
        const b = boxes.get(nodeClusterId);
        if (!b) boxes.set(nodeClusterId, { minX: x, maxX: x, minY: y, maxY: y });
        else {
          b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
          b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
        }
      });
    }

    // Pin the entered cluster's representative paper in place. We translate the
    // whole inner-view layout so the rep node lands exactly where it sat in the
    // outer view — the representative never moves; everything else carries the
    // same translation (and has already reshuffled into subcluster lanes), so it
    // moves relative to the fixed rep. Done before blobs/bridges/dividers so they
    // derive from the shifted yearX / lane positions and stay consistent.
    const anchor = isInner ? this.innerViewAnchor() : null;
    let dx = 0;
    let dy = 0;
    if (anchor && nodes.length) {
      const a = nodes.find(n => n.id === anchor.id);
      const natX = a ? a.x : nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
      const natY = a ? a.y : nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
      dx = anchor.x - natX;
      dy = anchor.y - natY;
      if (dx !== 0 || dy !== 0) {
        for (const n of nodes) { n.x += dx; n.y += dy; }
        for (const b of boxes.values()) {
          b.minX += dx; b.maxX += dx; b.minY += dy; b.maxY += dy;
        }
        for (const [y, x] of yearX) yearX.set(y, x + dx);
        for (let i = 0; i < laneCenters.length; i++) laneCenters[i] += dy;
        for (let i = 0; i < laneYStart.length; i++) laneYStart[i] += dy;
      }
    }

    // One coloured blob per cluster, around its representatives.
    const PAD_X = 38, PAD_TOP = 40, PAD_BOTTOM = 50;
    const blobs: Blob[] = [];

    // Group placed nodes by active clusterId to easily find their years.
    const clusterNodesMap = new Map<number, PlacedNode[]>();
    for (const p of placedFiltered) {
      const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
      let arr = clusterNodesMap.get(nodeClusterId);
      if (!arr) {
        arr = [];
        clusterNodesMap.set(nodeClusterId, arr);
      }
      arr.push(p);
    }

    for (const [nodeClusterId, members] of clusterNodesMap) {
      const yearsInCluster = members.map(m => m.paper.year!);
      const minYear = Math.min(...yearsInCluster);
      const maxYear = Math.max(...yearsInCluster);

      const clusterYears = years.filter(y => y >= minYear && y <= maxYear);

      const lane = laneIndex.get(nodeClusterId) ?? 0;
      const laneCenter = laneCenters[lane];

      const points: { x: number; topY: number; bottomY: number }[] = [];
      for (const y of clusterYears) {
        const x = yearX.get(y)!;
        const cellMembers = cells.get(`${lane}|${y}`);
        const k = cellMembers ? cellMembers.length : 0;
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
        const dx = 70;
        const capDx = PAD_X * 1.33;

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

      const b = boxes.get(nodeClusterId);
      const rectX = b ? b.minX - PAD_X : points[0].x - PAD_X;
      const rectY = b ? b.minY - PAD_TOP : points[0].topY;
      const rectW = b ? (b.maxX - b.minX) + 2 * PAD_X : 2 * PAD_X;
      const rectH = b ? (b.maxY - b.minY) + PAD_TOP + PAD_BOTTOM : points[0].bottomY - points[0].topY;

      const isMisc = !isInner && nodeClusterId === misc;
      blobs.push({
        topCluster: nodeClusterId,
        x: points[0].x - PAD_X,
        y: points[0].topY,
        path,
        rectX,
        rectY,
        rectW,
        rectH,
        color: this.clusterColorFor(nodeClusterId, isInner),
        isMisc,
        label: isMisc ? 'Miscellaneous' : '',
      });
    }

    const bridges = this.blobMerging()
      ? this.buildBridges(currentTopLevel, currentComm, laneIndex, laneCenters, boxes, nodes, years, yearX)
      : [];

    const dividers: { x: number }[] = [];
    for (let i = 0; i < years.length - 1; i++) {
      dividers.push({ x: (yearX.get(years[i])! + yearX.get(years[i + 1])!) / 2 });
    }

    const laneLines: { y: number }[] = [];
    for (let i = 0; i <= numLanes; i++) laneLines.push({ y: laneYStart[i] });

    const width = years.length
      ? yearX.get(years[years.length - 1])! + 80
      : 400;
    const height = laneYStart[numLanes] + 20;

    // Manual links between placed-with-year nodes.
    const known = new Set(placedFiltered.map(p => p.id));
    const seen = new Set<string>();
    const edges: LayoutEdge[] = [];
    for (const e of this.state.links()) {
      if (!known.has(e.fromId) || !known.has(e.toId)) continue;
      const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }

    const laneBoxes = laneClusters.map((id, i) => {
      const isMisc = !isInner && id === misc;
      const name = isMisc ? 'Miscellaneous' : (isInner ? `Subcluster ${id}` : `Cluster ${id}`);
      const color = this.clusterColorFor(id, isInner);
      
      const repIndex = currentTopLevel >= 0 ? this.repIndexOfCluster(currentTopLevel, id) : -1;
      const repTitle = repIndex >= 0 ? (this.baseNodes()[repIndex]?.title ?? '') : '';
      const size = currentTopLevel >= 0 ? this.clusterSize(currentTopLevel, id) : 0;

      const visiblePapers = placedFiltered.filter(p => {
        const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
        return nodeClusterId === id;
      }).length;
      
      const totalPapers = this.baseNodes().filter((n, idx) => {
        if (isInner) {
          return topComm[idx] === innerId && currentComm[idx] === id;
        }
        return currentComm[idx] === id;
      }).length;

      const visibleSeeds = placedFiltered.filter(p => {
        const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
        return nodeClusterId === id && this.state.initialSeedIds().has(paperId(p.paper));
      }).length;
      
      const totalSeeds = this.baseNodes().filter((n, idx) => {
        if (isInner) {
          return topComm[idx] === innerId && currentComm[idx] === id && this.state.initialSeedIds().has(n.paper_id);
        }
        return currentComm[idx] === id && this.state.initialSeedIds().has(n.paper_id);
      }).length;

      const visibleGold = placedFiltered.filter(p => {
        const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
        return nodeClusterId === id && this.starFor(p.paper.ok_score ?? 0) === 'gold';
      }).length;
      
      const totalGold = this.baseNodes().filter((n, idx) => {
        if (isInner) {
          return topComm[idx] === innerId && currentComm[idx] === id && this.starFor(repScore(n)) === 'gold';
        }
        return currentComm[idx] === id && this.starFor(repScore(n)) === 'gold';
      }).length;

      const visibleSilver = placedFiltered.filter(p => {
        const nodeClusterId = !isInner ? p.topCluster : currentComm[p.repIndex];
        return nodeClusterId === id && this.starFor(p.paper.ok_score ?? 0) === 'silver';
      }).length;
      
      const totalSilver = this.baseNodes().filter((n, idx) => {
        if (isInner) {
          return topComm[idx] === innerId && currentComm[idx] === id && this.starFor(repScore(n)) === 'silver';
        }
        return currentComm[idx] === id && this.starFor(repScore(n)) === 'silver';
      }).length;

      let summary: ClusterSummary | undefined = undefined;
      if (!isMisc && repIndex >= 0) {
        const repNode = this.baseNodes()[repIndex];
        if (repNode) {
          const rawTop = this.summaries.getTopLevel();
          if (rawTop >= 0) {
            const targetRawLvl = !isInner ? rawTop : rawTop - 1;
            if (targetRawLvl >= 0) {
              const rawComm = this.communitiesAtLevel()(targetRawLvl)[repIndex];
              if (rawComm !== undefined) {
                summary = this.summaries.summaryAt(targetRawLvl, rawComm);
              }
            }
          }
        }
      }

      // Staggered placement: sit the card just left of this cluster's left-most
      // node instead of in the shared left-aligned column. Falls back to the
      // aligned x when the cluster has no drawn nodes.
      const clusterBox = boxes.get(id);
      const cardX = this.staggeredCards()
        ? (clusterBox
            ? clusterBox.minX - NODE_RADIUS - 16 - this.cardWidth
            : this.cardAlignedX + dx)
        : this.cardAlignedX + dx;

      return {
        topCluster: id,
        laneIndex: i,
        name,
        color,
        isMisc,
        size,
        repTitle,
        totalPapers: `${visiblePapers} / ${totalPapers}`,
        totalSeeds: `${visibleSeeds} / ${totalSeeds}`,
        totalGoldStars: `${visibleGold} / ${totalGold}`,
        totalSilverStars: `${visibleSilver} / ${totalSilver}`,
        yStart: laneYStart[i],
        height: laneHeights[i],
        cardX,
        summary
      };
    });

    return {
      nodes, edges,
      yearColumns: years.map(y => ({ year: y, x: yearX.get(y)! })),
      dividers, laneLines, blobs, bridges, width, height,
      laneBoxes,
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
    laneCenters: number[],
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
      if (!years.length) return this.leftPadding();
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
      const laneCenter = laneCenters[lane];
      const box = boxes.get(parentTop);
      let x = repNode.year != null ? yearToX(repNode.year)
            : box ? (box.minX + box.maxX) / 2 : this.leftPadding();
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
    {
      id: number;
      name: string;
      color: string;
      repTitle: string;
      size: number;
      isMisc: boolean;
      totalPapers: string;
      totalSeeds: string;
      totalGoldStars: string;
      totalSilverStars: string;
    } | null
  >(() => {
    const id = this.selectedClusterId();
    if (id === null) return null;
    const blob = this.blobs().find(b => b.topCluster === id);
    if (!blob) return null;
    const innerId = this.innerViewClusterId();
    const isInner = innerId !== null;
    const top = isInner ? Math.max(0, this.topLevel() - 1) : this.topLevel();
    const repIndex = top >= 0 ? this.repIndexOfCluster(top, id) : -1;
    const repTitle = repIndex >= 0 ? (this.baseNodes()[repIndex]?.title ?? '') : '';
    const size = top >= 0 ? this.clusterSize(top, id) : 0;

    const base = this.baseNodes();
    const topComm = this.communitiesAtLevel()(this.topLevel());
    const currentComm = this.communitiesAtLevel()(top);
    const paperClusterMap = new Map<string, number>();
    for (let i = 0; i < base.length; i++) {
      paperClusterMap.set(base[i].paper_id, currentComm[i]);
    }

    const visiblePapers = this.nodes().filter(n => paperClusterMap.get(n.id) === id).length;
    const totalPapers = base.filter((n, i) => (!isInner || topComm[i] === innerId) && currentComm[i] === id).length;

    const visibleSeeds = this.nodes().filter(n => this.isSeedNode(n) && paperClusterMap.get(n.id) === id).length;
    const totalSeeds = base.filter((n, i) => (!isInner || topComm[i] === innerId) && currentComm[i] === id && this.state.initialSeedIds().has(n.paper_id)).length;

    const visibleGold = this.nodes().filter(n => n.star === 'gold' && paperClusterMap.get(n.id) === id).length;
    const totalGold = base.filter((n, i) => (!isInner || topComm[i] === innerId) && currentComm[i] === id && this.starFor(repScore(n)) === 'gold').length;

    const visibleSilver = this.nodes().filter(n => n.star === 'silver' && paperClusterMap.get(n.id) === id).length;
    const totalSilver = base.filter((n, i) => (!isInner || topComm[i] === innerId) && currentComm[i] === id && this.starFor(repScore(n)) === 'silver').length;

    return {
      id,
      name: isInner ? `Subcluster ${id}` : this.clusterName(id),
      color: blob.color,
      repTitle,
      size,
      isMisc: blob.isMisc,
      totalPapers: `${visiblePapers} / ${totalPapers}`,
      totalSeeds: `${visibleSeeds} / ${totalSeeds}`,
      totalGoldStars: `${visibleGold} / ${totalGold}`,
      totalSilverStars: `${visibleSilver} / ${totalSilver}`,
    };
  });

  isClusterSelected(topCluster: number): boolean {
    return this.selectedClusterId() === topCluster;
  }

  readonly selectedClusterSummary = computed<ClusterSummary | undefined>(() => {
    const id = this.selectedClusterId();
    if (id === null) return undefined;
    const isInner = this.innerViewClusterId() !== null;
    const top = isInner ? Math.max(0, this.topLevel() - 1) : this.topLevel();
    const repIndex = top >= 0 ? this.repIndexOfCluster(top, id) : -1;
    const repNode = repIndex >= 0 ? this.baseNodes()[repIndex] : undefined;
    if (!repNode) return undefined;

    const rawTop = this.summaries.getTopLevel();
    if (rawTop < 0) return undefined;
    const targetRawLvl = isInner ? rawTop - 1 : rawTop;
    if (targetRawLvl < 0) return undefined;

    const rawComm = this.communitiesAtLevel()(targetRawLvl)[repIndex];
    if (rawComm === undefined) return undefined;

    return this.summaries.summaryAt(targetRawLvl, rawComm);
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

  /** Select a cluster by its ID directly. */
  selectClusterById(id: number, event: MouseEvent): void {
    event.stopPropagation();
    if (this.didPan) return;
    this.expandPopup.set(null);
    this.selectedNodeId.set(null);
    this.selectedClusterId.set(id);
  }

  /** Click on bare canvas background → deselect the cluster (and node) + popups. */
  onBackgroundClick(event: MouseEvent): void {
    if (this.didPan) return;
    const t = event.target as Element;
    if (t.closest('.graph-svg__node') || t.closest('.graph-svg__blob') ||
        t.closest('.zoom-controls') || t.closest('.expand-popup') ||
        t.closest('.graph-settings') || t.closest('.cluster-popup') ||
        t.closest('.lane-box') || t.closest('.graph-svg__axis')) {
      return;
    }
    this.selectedClusterId.set(null);
    this.selectedNodeId.set(null);
    this.expandPopup.set(null);
  }

  /** Global document click handler to deselect selected timeline year/gaps when clicking outside */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    this.selectedYear.set(null);
    this.selectedGap.set(null);
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

  // --- year-axis selection + expand ------------------------------------------

  /** Toggle the selected year on the axis (single selection). Clears any gap. */
  selectYear(year: number): void {
    this.expandPopup.set(null);
    this.selectedGap.set(null);
    this.selectedYear.update(cur => (cur === year ? null : year));
  }

  /** Whether `gap` is the currently selected in-between gap. */
  isGapSelected(gap: { leftYear: number; rightYear: number }): boolean {
    const s = this.selectedGap();
    return !!s && s.leftYear === gap.leftYear && s.rightYear === gap.rightYear;
  }

  /** Toggle the selected in-between gap on the axis. Clears any selected year. */
  selectGap(gap: { leftYear: number; rightYear: number }): void {
    this.expandPopup.set(null);
    this.selectedYear.set(null);
    this.selectedGap.update(cur =>
      cur && cur.leftYear === gap.leftYear && cur.rightYear === gap.rightYear ? null : gap);
  }

  /** Double click a year: select it and immediately expand if possible. */
  onYearDblClick(year: number): void {
    this.expandPopup.set(null);
    this.selectedGap.set(null);
    this.selectedYear.set(year);
    if (this.canExpandYear()) {
      this.expandYear();
    }
  }

  /** Double click a gap: select it and immediately expand if possible. */
  onGapDblClick(gap: { leftYear: number; rightYear: number }): void {
    this.expandPopup.set(null);
    this.selectedYear.set(null);
    this.selectedGap.set(gap);
    if (this.canExpandGap()) {
      this.expandGap();
    }
  }

  /** World x of the selected year's column, or null when it isn't a column. */
  readonly selectedYearX = computed<number | null>(() => {
    const y = this.selectedYear();
    if (y === null) return null;
    const col = this.yearColumns().find(c => c.year === y);
    return col ? col.x : null;
  });

  /**
   * In-between markers: one per adjacent pair of non-consecutive year columns,
   * positioned at the midpoint between them. Rendered as a clickable `↔` on the
   * axis (you cannot click between, e.g., 2010 and 2011 — they are consecutive).
   */
  readonly yearGaps = computed<{ leftYear: number; rightYear: number; x: number }[]>(() => {
    const cols = this.yearColumns();
    const gaps: { leftYear: number; rightYear: number; x: number }[] = [];
    for (let i = 0; i < cols.length - 1; i++) {
      if (cols[i + 1].year - cols[i].year > 1) {
        gaps.push({
          leftYear: cols[i].year,
          rightYear: cols[i + 1].year,
          x: (cols[i].x + cols[i + 1].x) / 2,
        });
      }
    }
    return gaps;
  });

  /** World x of the selected gap's marker, or null when none is selected. */
  readonly selectedGapX = computed<number | null>(() => {
    const sel = this.selectedGap();
    if (!sel) return null;
    const g = this.yearGaps().find(
      g => g.leftYear === sel.leftYear && g.rightYear === sel.rightYear);
    return g ? g.x : null;
  });

  /**
   * Per-lane-cluster ordered candidate queues for a given year — the nodes an
   * Expand on that year would drill through. Mirrors laneLayout()'s view
   * derivation so it matches the clusters currently on screen; built via the
   * pure yearExpandQueues() helper and mapped onto PlacedNodes.
   */
  private buildQueuesForYear(year: number): Map<number, PlacedNode[]> {
    const levels = this.levels();
    const base = this.baseNodes();
    if (!levels.length || !base.length) return new Map();

    const top = levels.length - 1;
    const innerId = this.innerViewClusterId();
    const isInner = innerId !== null;
    const currentTopLevel = isInner ? Math.max(0, top - 1) : top;
    const currentComm = this.communitiesAtLevel()(currentTopLevel);
    const topComm = this.communitiesAtLevel()(top);

    const commAtLevel: number[][] = [];
    for (let L = 0; L <= currentTopLevel; L++) commAtLevel[L] = this.communitiesAtLevel()(L);

    const nodeYear = base.map(n => n.year ?? null);
    const nodeScore = base.map(n => repScore(n));
    const inView = base.map((_, i) => !isInner || topComm[i] === innerId);

    const placedIds = new Set(this.state.placed().map(p => p.id));
    const isPlaced = (i: number) => placedIds.has(base[i].paper_id);

    const raw = yearExpandQueues({
      commAtLevel, currentTopLevel, nodeYear, nodeScore,
      laneClusterOf: currentComm, inView, selectedYear: year, isPlaced,
    });

    const queues = new Map<number, PlacedNode[]>();
    for (const [cluster, cands] of raw) {
      queues.set(cluster, cands.map(c => this.buildPlaced(c.level, c.community, c.paperIndex)));
    }
    return queues;
  }

  /** Years that contain at least one unplaced candidate paper in the current view. */
  readonly expandableYears = computed<Set<number>>(() => {
    const levels = this.levels();
    const base = this.baseNodes();
    if (!levels.length || !base.length) return new Set();

    const top = levels.length - 1;
    const innerId = this.innerViewClusterId();
    const isInner = innerId !== null;
    const topComm = this.communitiesAtLevel()(top);

    const placedIds = new Set(this.state.placed().map(p => p.id));
    const result = new Set<number>();

    for (let i = 0; i < base.length; i++) {
      const node = base[i];
      if (node.year == null) continue;
      // Is it in view?
      const inView = !isInner || topComm[i] === innerId;
      if (!inView) continue;
      // Is it placed?
      const isPlaced = placedIds.has(node.paper_id);
      if (isPlaced) continue;

      result.add(node.year);
    }
    return result;
  });

  /** Whether the given year is expandable in the current view. */
  isYearExpandable(year: number): boolean {
    return this.expandableYears().has(year);
  }

  /** Whether the given gap is expandable in the current view. */
  isGapExpandable(gap: { leftYear: number; rightYear: number }): boolean {
    const midYears = middleYears(gap.leftYear, gap.rightYear);
    return midYears.some(y => this.expandableYears().has(y));
  }

  /** Candidate queues for the selected year (empty when no year is selected). */
  private readonly yearCandidateQueues = computed<Map<number, PlacedNode[]>>(() => {
    const year = this.selectedYear();
    if (year === null) return new Map();
    return this.buildQueuesForYear(year);
  });

  /**
   * Candidate queues for the selected gap — one queue-map per middle year of the
   * [leftYear, rightYear] range (one map for an odd range, two for an even one).
   */
  private readonly gapCandidateQueues = computed<Map<number, PlacedNode[]>[]>(() => {
    const gap = this.selectedGap();
    if (!gap) return [];
    return middleYears(gap.leftYear, gap.rightYear).map(y => this.buildQueuesForYear(y));
  });

  /** Whether any shown cluster still has an un-placed node from the selected year. */
  readonly canExpandYear = computed(() => {
    for (const q of this.yearCandidateQueues().values()) if (q.length) return true;
    return false;
  });

  /** Whether expanding the selected gap would place any node. */
  readonly canExpandGap = computed(() => {
    for (const queues of this.gapCandidateQueues())
      for (const q of queues.values()) if (q.length) return true;
    return false;
  });

  /**
   * Place the next node from each lane cluster's queue. Each new node is linked
   * to its cluster's coarsest placed node so the graph stays connected. Reads
   * the live placed set, so sequential calls chain correctly.
   */
  private placeQueues(queues: Map<number, PlacedNode[]>): void {
    if (!queues.size) return;

    // Coarsest placed node per top-level cluster — the parent to link new nodes to.
    const parentByCluster = new Map<number, PlacedNode>();
    for (const p of this.state.placed()) {
      const cur = parentByCluster.get(p.topCluster);
      if (!cur || p.level > cur.level) parentByCluster.set(p.topCluster, p);
    }

    const toAdd: PlacedNode[] = [];
    const newLinks: LayoutEdge[] = [];
    for (const [cluster, queue] of queues) {
      const cand = queue[0];
      if (!cand) continue;
      toAdd.push(cand);
      const parent = parentByCluster.get(cand.topCluster) ?? parentByCluster.get(cluster);
      if (parent && parent.id !== cand.id) newLinks.push({ fromId: parent.id, toId: cand.id });
    }
    if (!toAdd.length) return;
    this.state.placed.update(p => [...p, ...toAdd]);
    if (newLinks.length) this.state.links.update(l => [...l, ...newLinks]);
  }

  /**
   * Expand the selected year: for every shown cluster, place the next node from
   * its year queue (the highest-level, highest-ok-score not-yet-placed candidate).
   * Repeated clicks drill further down each queue.
   */
  expandYear(): void {
    this.placeQueues(this.yearCandidateQueues());
  }

  /**
   * Expand the selected in-between gap: behaves like pressing Expand on the
   * year(s) literally in the middle of the [leftYear, rightYear] range. An
   * even-length range expands both middle years (placed sequentially).
   */
  expandGap(): void {
    for (const queues of this.gapCandidateQueues()) this.placeQueues(queues);
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
    this.innerViewClusterId.set(null);
    this.innerViewAnchor.set(null);
    this.expandPopup.set(null);
    this.selectedYear.set(null);
    this.selectedGap.set(null);
    this.state.clear();
  }

  moveInside(clusterId: number, event?: MouseEvent): void {
    event?.stopPropagation();
    
    // Find the blob in the current layout
    const blob = this.blobs().find(b => b.topCluster === clusterId);
    if (!blob) {
      this.innerViewAnchor.set(null);
      this.innerViewClusterId.set(clusterId);
      this.selectedClusterId.set(null);
      this.selectedNodeId.set(null);
      this.expandPopup.set(null);
      return;
    }

    // Capture geometry
    const initialRect = {
      x: blob.rectX,
      y: blob.rectY,
      w: blob.rectW,
      h: blob.rectH
    };

    // Pin the cluster's representative paper: capture its current world position
    // so the inner-view layout can be translated to keep it exactly here. If the
    // rep node isn't on screen (filtered out), fall back to the blob centre, which
    // maps the inner layout's centroid here instead.
    const repIdx = this.repIndexOfCluster(this.topLevel(), clusterId);
    const repId = repIdx >= 0 ? this.baseNodes()[repIdx]?.paper_id : undefined;
    const repNode = repId != null ? this.nodes().find(n => n.id === repId) : undefined;
    this.innerViewAnchor.set(
      repNode
        ? { id: repNode.id, x: repNode.x, y: repNode.y }
        : { id: '', x: blob.rectX + blob.rectW / 2, y: blob.rectY + blob.rectH / 2 },
    );
    
    // The stages overlap rather than each waiting for the previous to finish:
    //   t=0    fade-out: siblings of the target start fading; overlay sits on the
    //          target's lane rect.
    //   t=160  expand:   overlay grows to fill the canvas (0.6s, full ~t=760),
    //          overlapping the tail of the sibling fade so they read as one motion.
    //   t=700  shift:    swap in the inner-view layout behind the (now full)
    //          overlay; target content stays put — it never fades, and the new
    //          inner content fades in via CSS @starting-style instead of popping.
    //   t=860  reveal:   fade the full-panel overlay out (0.4s) to uncover the
    //          settled inner view — never removed instantly (that read as a flash).
    //   t=1240 end:      drop the overlay element once it is fully transparent.
    const guard = (fn: () => void) => () => {
      const state = this.transitionState();
      if (!state || state.targetClusterId !== clusterId) return;
      fn();
    };

    this.transitionState.set({
      stage: 'fade-out',
      targetClusterId: clusterId,
      rect: initialRect,
      color: blob.color
    });

    setTimeout(guard(() => {
      this.transitionState.update(s => s && { ...s, stage: 'expand' });
    }), 160);

    setTimeout(guard(() => {
      this.innerViewClusterId.set(clusterId);
      this.selectedClusterId.set(null);
      this.selectedNodeId.set(null);
      this.expandPopup.set(null);
      this.selectedYear.set(null);
      this.selectedGap.set(null);
      this.transitionState.update(s => s && { ...s, stage: 'shift' });
    }), 700);

    setTimeout(guard(() => {
      this.transitionState.update(s => s && { ...s, stage: 'reveal' });
    }), 860);

    setTimeout(guard(() => {
      this.transitionState.set(null);
    }), 1240);
  }

  resetToMainView(): void {
    this.transitionState.set(null);
    this.innerViewClusterId.set(null);
    this.innerViewAnchor.set(null);
    this.selectedClusterId.set(null);
    this.selectedNodeId.set(null);
    this.expandPopup.set(null);
    this.selectedYear.set(null);
    this.selectedGap.set(null);
  }

  // --- transition animation helpers -------------------------------------------

  getScreenRect(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const zoom = this.zoom();
    const panX = this.panX();
    const panY = this.panY();
    return {
      x: rect.x * zoom + panX,
      y: rect.y * zoom + panY,
      w: rect.w * zoom,
      h: rect.h * zoom
    };
  }

  /** True while the outer-view structure (lanes, dividers, bridges) should stay
   *  hidden — during fade-out/expand, but NOT once the inner-view layout has been
   *  swapped in (shift), so the inner view is fully formed before the overlay clears. */
  /** True once the inner-view layout has been swapped in (shift/reveal): from
   *  that point everything on screen belongs to the target cluster, so nothing
   *  should carry the fade-out class. */
  private innerViewActive(): boolean {
    const stage = this.transitionState()?.stage;
    return stage === 'shift' || stage === 'reveal';
  }

  isStructureFadedOut(): boolean {
    const state = this.transitionState();
    return !!state && !this.innerViewActive();
  }

  isNodeOutsideTransitionTarget(node: RenderNode): boolean {
    const state = this.transitionState();
    if (!state) return false;
    // Once the inner-view layout is active, every node shown belongs to the
    // target cluster — never fade them (they must not flicker out and back in).
    if (this.innerViewActive()) return false;
    return node.clusterId !== state.targetClusterId;
  }

  isBlobOutsideTransitionTarget(blob: any): boolean {
    const state = this.transitionState();
    if (!state) return false;
    // Inner-view blobs (sub-clusters of the target) should be visible.
    if (this.innerViewActive()) return false;
    if (state.stage === 'expand') return true;
    return blob.topCluster !== state.targetClusterId;
  }

  isClusterOutsideTransitionTarget(clusterId: number): boolean {
    const state = this.transitionState();
    if (!state) return false;
    if (this.innerViewActive()) return false;
    return clusterId !== state.targetClusterId;
  }

  isEdgeOutsideTransitionTarget(edge: LayoutEdge): boolean {
    const state = this.transitionState();
    if (!state) return false;
    if (this.innerViewActive()) return false;

    const sourceNode = this.nodes().find(n => n.id === edge.fromId);
    const targetNode = this.nodes().find(n => n.id === edge.toId);
    if (!sourceNode || !targetNode) return true;

    return sourceNode.clusterId !== state.targetClusterId || targetNode.clusterId !== state.targetClusterId;
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
  togglePanel(): void {
    const nextCollapsed = !this.panelCollapsed();
    this.panelCollapsed.set(nextCollapsed);
    this.state.autoOpenEnabled.set(!nextCollapsed);
  }

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
        t.closest('.cluster-popup') || t.closest('.graph-svg__axis')) {
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
