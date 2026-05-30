import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { OkGraphStateService } from '../../core/services/okgraph-state.service';
import { getCommunitiesAtLevel } from '../citgraph/louvain';
import { Paper } from '../../core/models/paper.model';
import { citNodeToPaper, repScore } from './cit-node';
import { clusterColor } from './community-colors';
import { edgePath as buildEdgePath, LayoutEdge, TOP_PADDING } from '../graph/graph-layout';

/** A node placed on the OK-Graph: the representative of a Louvain cluster. */
interface PlacedNode {
  id: string;          // representative paper_id
  repIndex: number;    // base node index of the representative
  level: number;       // Louvain hierarchy index the cluster lives at (-1 = leaf paper)
  community: number;   // community id at that level (or base index for a leaf)
  topCluster: number;  // highest-level community this node belongs to (its lane)
  paper: Paper;
  clusterSize: number; // number of base papers in the cluster
}

interface Blob {
  topCluster: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** A positioned node on the canvas. */
interface RenderNode {
  id: string;
  paper: Paper;
  x: number;
  y: number;
  letter: string;
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
  imports: [DecimalPipe],
  templateUrl: './okgraph.component.html',
  styleUrl: './okgraph.component.scss',
})
export class OkGraphComponent {
  readonly state = inject(OkGraphStateService);

  readonly TOP_PADDING = TOP_PADDING;
  readonly selectedNodeId = signal<string | null>(null);
  readonly hoveredNodeId = signal<string | null>(null);
  readonly panelCollapsed = signal(false);
  readonly zoom = signal(1);
  readonly expandPopup = signal<ExpandPopup | null>(null);

  private static readonly ZOOM_MIN = 0.3;
  private static readonly ZOOM_MAX = 2;
  private static readonly ZOOM_STEP = 0.15;

  /** Nodes currently on the canvas and the manual links between them. */
  private readonly placed = signal<PlacedNode[]>([]);
  private readonly links = signal<LayoutEdge[]>([]);

  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private expandClickTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seededFor: unknown = null;

  // --- hierarchy helpers -----------------------------------------------------

  private readonly baseNodes = computed(() => this.state.nodes());
  private readonly levels = computed(() => this.state.louvain()?.levels ?? []);
  private readonly topLevel = computed(() => this.levels().length - 1);

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
    // Re-seed the top-level representatives whenever a new hierarchy arrives.
    effect(() => {
      const lv = this.state.louvain();
      if (lv !== this.seededFor) {
        this.seededFor = lv;
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
    this.expandPopup.set(null);
    const levels = this.levels();
    if (!levels.length || !this.baseNodes().length) {
      this.placed.set([]); this.links.set([]); return;
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
    this.placed.set(placed);
    this.links.set([]);
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
    const placedIds = new Set(this.placed().map(p => p.id));

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
    this.placed.update(p => [...p, cand]);
    this.links.update(l => [...l, { fromId: parent.id, toId: cand.id }]);
  }

  // --- swimlane layout -------------------------------------------------------
  // One horizontal lane per highest-level cluster; x is by year, y is the node's
  // lane (stacked within the lane when several share a lane + year).

  private readonly placedById = computed(() => new Map(this.placed().map(p => [p.id, p])));

  private readonly laneLayout = computed(() => {
    const levels = this.levels();
    const placed = this.placed().filter(p => p.paper.year != null);
    const empty = {
      nodes: [] as RenderNode[], edges: [] as LayoutEdge[],
      yearColumns: [] as { year: number; x: number }[],
      dividers: [] as { x: number }[], laneLines: [] as { y: number }[],
      blobs: [] as Blob[],
      width: 400, height: 300,
    };
    if (!levels.length || placed.length === 0) return empty;

    const top = levels.length - 1;
    const topComm = this.communitiesAtLevel()(top);

    // Lanes: every highest-level cluster, ordered by descending size.
    const sizeOf = new Map<number, number>();
    for (const c of topComm) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    const laneClusters = [...sizeOf.keys()].sort(
      (a, b) => (sizeOf.get(b)! - sizeOf.get(a)!) || a - b,
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
        nodes.push({ id: p.id, paper: p.paper, x, y, letter: letterOf.get(p.id) ?? '?' });
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
    for (const [topCluster, b] of boxes) {
      blobs.push({
        topCluster,
        x: b.minX - PAD_X,
        y: b.minY - PAD_TOP,
        w: (b.maxX - b.minX) + 2 * PAD_X,
        h: (b.maxY - b.minY) + PAD_TOP + PAD_BOTTOM,
        color: clusterColor(topCluster),
      });
    }

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
    for (const e of this.links()) {
      if (!known.has(e.fromId) || !known.has(e.toId)) continue;
      const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }

    return {
      nodes, edges,
      yearColumns: years.map(y => ({ year: y, x: yearX.get(y)! })),
      dividers, laneLines, blobs, width, height,
    };
  });

  readonly nodes = computed(() => this.laneLayout().nodes);
  readonly edges = computed(() => this.laneLayout().edges);
  readonly yearColumns = computed(() => this.laneLayout().yearColumns);
  readonly dividers = computed(() => this.laneLayout().dividers);
  readonly laneLines = computed(() => this.laneLayout().laneLines);
  readonly blobs = computed(() => this.laneLayout().blobs);
  readonly svgWidth = computed(() => this.laneLayout().width);
  readonly svgHeight = computed(() => this.laneLayout().height);

  private readonly nodeMap = computed(() => new Map(this.nodes().map(n => [n.id, n])));

  readonly hasContent = computed(() => this.state.hasContent());
  readonly placedCount = computed(() => this.placed().length);

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

  // --- interaction -----------------------------------------------------------

  selectNode(node: RenderNode): void {
    this.expandPopup.set(null);
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.selectedNodeId.update(cur => (cur === node.id ? null : node.id));
    }, 250);
  }

  onNodeDblClick(node: RenderNode, event: MouseEvent): void {
    event.stopPropagation();
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.selectedNodeId.set(node.id);
    const placed = this.placedById().get(node.id);
    if (!placed) return;
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
      x: offsetX * this.zoom(),
      y: (node.y + 16) * this.zoom(),
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
    this.placed.update(p => p.filter(n => n.id !== id));
    this.links.update(l => l.filter(e => e.fromId !== id && e.toId !== id));
    this.selectedNodeId.set(null);
  }

  clearGraph(): void {
    this.selectedNodeId.set(null);
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

  zoomIn(): void {
    this.zoom.update(z => Math.min(z + OkGraphComponent.ZOOM_STEP, OkGraphComponent.ZOOM_MAX));
  }
  zoomOut(): void {
    this.zoom.update(z => Math.max(z - OkGraphComponent.ZOOM_STEP, OkGraphComponent.ZOOM_MIN));
  }
  resetZoom(): void { this.zoom.set(1); }
  get zoomPercent(): number { return Math.round(this.zoom() * 100); }

  onCanvasWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = -Math.sign(event.deltaY) * OkGraphComponent.ZOOM_STEP;
    this.zoom.update(z =>
      Math.min(Math.max(z + delta, OkGraphComponent.ZOOM_MIN), OkGraphComponent.ZOOM_MAX),
    );
  }
}
