import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CitGraphService, CitGraphNode, CitGraphEdge, CitGraphResponse } from '../../core/services/citgraph.service';
import { DemoModeService } from '../../core/services/demo-mode.service';
import { BookshelfService, BookshelfItem } from '../../core/services/bookshelf.service';
import { louvain, getCommunitiesAtLevel, LouvainResult } from './louvain';
import { Router } from '@angular/router';
import { NotificationService } from '../../core/services/notification.service';
import { OkGraphStateService } from '../../core/services/okgraph-state.service';
import { ProjectContextService } from '../../core/services/project-context.service';
import { getArchetypeIcon } from '../../shared/utils/archetype-icons';

interface LayoutNode {
  id: string;
  data: CitGraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  community: number;
}

// What is actually drawn on the canvas. At level 0 each display node is a
// single paper; at level ≥1 the graph collapses to one meta-node per cluster.
interface DisplayNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  label: string;
  kind: 'paper' | 'cluster';
  paper: CitGraphNode | null;
  clusterId: number | null;
  count: number;
}

interface DisplayEdge {
  source: string;
  target: string;
  weight: number;
}

const COMMUNITY_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
  '#db2777', '#0891b2', '#65a30d', '#ea580c', '#4f46e5',
  '#be123c', '#0d9488', '#b45309', '#7e22ce', '#c2410c',
];

@Component({
  selector: 'app-citgraph',
  standalone: true,
  imports: [DecimalPipe, FormsModule],
  templateUrl: './citgraph.component.html',
  styleUrl: './citgraph.component.scss',
})
export class CitGraphComponent {
  private readonly citgraphSvc = inject(CitGraphService);
  private readonly demo = inject(DemoModeService);
  private readonly bookshelfSvc = inject(BookshelfService);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);
  private readonly okGraphState = inject(OkGraphStateService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly elRef = inject(ElementRef);

  getArchetypeIcon(archetype?: string | null): string {
    return getArchetypeIcon(archetype);
  }

  readonly bookshelfOpen = signal(false);
  readonly bookshelfItems = signal<BookshelfItem[]>([]);

  readonly paperId = signal('');
  readonly kHops = signal(1);
  readonly maxPerHop = signal(20);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly graphData = signal<CitGraphResponse | null>(null);
  readonly layoutNodes = signal<LayoutNode[]>([]);
  readonly layoutEdges = signal<{ source: string; target: string }[]>([]);

  readonly selectedNodeId = signal<string | null>(null);
  readonly hoveredNodeId = signal<string | null>(null);
  readonly zoom = signal(1);
  private static readonly ZOOM_MIN = 0.2;
  private static readonly ZOOM_MAX = 3;
  private static readonly ZOOM_STEP = 0.15;

  readonly louvainResult = signal<LouvainResult | null>(null);
  // Display level numbering: 0 = no clusters (raw graph), 1 = the finest
  // Louvain communities, 2 = clusters of those, and so on. Internally a
  // display level L (≥1) maps to hierarchy index L-1.
  readonly louvainLevel = signal(0);
  readonly resolution = signal(1);
  readonly maxLevels = signal(10);
  readonly selectedClusterId = signal<number | null>(null);

  /** Whether Louvain has been run on the current graph. */
  readonly louvainActive = computed(() => this.louvainResult() !== null);

  /** Communities (hulls + colors) are only shown from level 1 upward. */
  readonly showCommunities = computed(() => this.louvainActive() && this.louvainLevel() >= 1);

  /** Selectable levels: 0 (none) plus one per detected hierarchy level. */
  readonly levelOptions = computed(() =>
    Array.from({ length: (this.louvainResult()?.levels.length ?? 0) + 1 }, (_, i) => i),
  );

  readonly selectedNode = computed<CitGraphNode | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return this.layoutNodes().find(n => n.id === id)?.data ?? null;
  });

  readonly communityLegend = computed(() => {
    if (!this.showCommunities()) return [];
    const nodes = this.layoutNodes();
    const counts = new Map<number, number>();
    for (const n of nodes) {
      counts.set(n.community, (counts.get(n.community) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({
        id,
        count,
        color: COMMUNITY_COLORS[id % COMMUNITY_COLORS.length],
      }));
  });

  // Composition of the currently inspected cluster, at the active level.
  // A cluster is made up of finer sub-clusters (the communities one level
  // below) and ultimately of papers (the leaf nodes). At level 0 the leaves
  // are the papers themselves, so there are no separate sub-clusters.
  readonly clusterInspection = computed(() => {
    const cid = this.selectedClusterId();
    if (cid === null || !this.showCommunities()) return null;
    const result = this.louvainResult();
    if (!result) return null;
    const nodes = this.layoutNodes();

    const papers = nodes
      .filter(n => n.community === cid)
      .map(n => {
        const score = +(1.0 * Math.log10(1 + (n.data.citation_count || 0))).toFixed(2);
        return { id: n.id, title: n.data.title, score, isRepresentative: false };
      })
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    if (!papers.length) return null;
    papers[0].isRepresentative = true;

    // Display level L (≥1) is hierarchy index L-1. Its sub-clusters are the
    // communities one level finer (hierarchy index L-2), which only exist from
    // display level 2 upward; at level 1 the sub-units are the papers.
    const level = this.louvainLevel();
    let subClusters: { id: number; size: number }[] = [];
    if (level >= 2) {
      const finer = getCommunitiesAtLevel(result.levels, nodes.length, level - 2);
      const counts = new Map<number, number>();
      nodes.forEach((n, i) => {
        if (n.community !== cid) return;
        counts.set(finer[i], (counts.get(finer[i]) ?? 0) + 1);
      });
      subClusters = [...counts.entries()]
        .map(([id, size]) => ({ id, size }))
        .sort((a, b) => b.size - a.size);
    }

    return {
      id: cid,
      color: COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length],
      level,
      paperCount: papers.length,
      subClusterCount: level >= 2 ? subClusters.length : papers.length,
      subClusters,
      papers,
    };
  });

  // Nodes drawn on the canvas. Level 0 → individual papers; level ≥1 → one
  // collapsed meta-node per cluster, sized by how many papers it contains.
  readonly displayNodes = computed<DisplayNode[]>(() => {
    const nodes = this.layoutNodes();
    if (!this.showCommunities()) {
      const seed = this.graphData()?.seed_id;
      return nodes.map(n => ({
        id: n.id,
        x: n.x,
        y: n.y,
        radius: n.id === seed ? 18 : 12,
        color: hopColor(n.data.hop),
        label: truncate(n.data.title),
        kind: 'paper' as const,
        paper: n.data,
        clusterId: null,
        count: 1,
      }));
    }

    const groups = new Map<number, LayoutNode[]>();
    for (const n of nodes) {
      let arr = groups.get(n.community);
      if (!arr) { arr = []; groups.set(n.community, arr); }
      arr.push(n);
    }
    const metaNodes: DisplayNode[] = [...groups.entries()].map(([cid, members]) => {
      const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
      const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
      return {
        id: `cluster-${cid}`,
        x: cx,
        y: cy,
        radius: Math.min(46, 12 + Math.sqrt(members.length) * 4),
        color: COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length],
        label: `Cluster ${cid} · ${members.length}`,
        kind: 'cluster' as const,
        paper: null,
        clusterId: cid,
        count: members.length,
      };
    });
    // Centroids of coarse clusters can overlap; nudge them apart so each
    // meta-node stays distinct, then shift back into positive bounds so
    // nothing is clipped at the top/left edge. Deterministic for a layout.
    spreadClusterNodes(metaNodes);
    const minX = Math.min(...metaNodes.map(n => n.x - n.radius));
    const minY = Math.min(...metaNodes.map(n => n.y - n.radius));
    for (const n of metaNodes) {
      n.x += 80 - minX;
      n.y += 80 - minY;
    }
    return metaNodes;
  });

  // Edges drawn on the canvas. Level 0 → the raw citation edges; level ≥1 →
  // edges aggregated between clusters (intra-cluster edges are dropped).
  readonly displayEdges = computed<DisplayEdge[]>(() => {
    const edges = this.layoutEdges();
    if (!this.showCommunities()) {
      return edges.map(e => ({ source: e.source, target: e.target, weight: 1 }));
    }
    const commById = new Map(this.layoutNodes().map(n => [n.id, n.community]));
    const agg = new Map<string, DisplayEdge>();
    for (const e of edges) {
      const cs = commById.get(e.source);
      const ct = commById.get(e.target);
      if (cs === undefined || ct === undefined || cs === ct) continue;
      const a = Math.min(cs, ct), b = Math.max(cs, ct);
      const key = `${a}|${b}`;
      const cur = agg.get(key);
      if (cur) cur.weight++;
      else agg.set(key, { source: `cluster-${a}`, target: `cluster-${b}`, weight: 1 });
    }
    return [...agg.values()];
  });

  private readonly displayNodePos = computed(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of this.displayNodes()) m.set(n.id, { x: n.x, y: n.y });
    return m;
  });

  /** Id of the currently active display node (selected paper or cluster). */
  readonly activeDisplayId = computed<string | null>(() => {
    if (!this.showCommunities()) return this.selectedNodeId();
    const c = this.selectedClusterId();
    return c === null ? null : `cluster-${c}`;
  });

  private readonly activeNeighbors = computed(() => {
    const a = this.activeDisplayId();
    const set = new Set<string>();
    if (!a) return set;
    for (const e of this.displayEdges()) {
      if (e.source === a) set.add(e.target);
      else if (e.target === a) set.add(e.source);
    }
    return set;
  });

  readonly svgWidth = computed(() => {
    const nodes = this.displayNodes();
    if (!nodes.length) return 800;
    return Math.max(800, Math.max(...nodes.map(n => n.x + n.radius)) + 80);
  });

  readonly svgHeight = computed(() => {
    const nodes = this.displayNodes();
    if (!nodes.length) return 600;
    return Math.max(600, Math.max(...nodes.map(n => n.y + n.radius)) + 80);
  });

  buildGraph(): void {
    const id = this.paperId().trim();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.graphData.set(null);
    this.louvainResult.set(null);
    this.louvainLevel.set(0);
    this.selectedNodeId.set(null);
    this.selectedClusterId.set(null);

    const request$ = this.demo.enabled()
      ? this.citgraphSvc.buildDemo(id, this.kHops(), this.maxPerHop())
      : this.citgraphSvc.build(id, this.kHops(), this.maxPerHop());

    request$.subscribe({
      next: (data) => {
        this.graphData.set(data);
        this.layoutEdges.set(data.edges);
        this.runLayout(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error?.detail || 'Failed to build citation graph');
      },
    });
  }

  toggleBookshelf(): void {
    if (this.bookshelfOpen()) {
      this.bookshelfOpen.set(false);
      return;
    }
    this.bookshelfSvc.list().subscribe({
      next: (items) => {
        this.bookshelfItems.set(items);
        this.bookshelfOpen.set(true);
      },
    });
  }

  pickBookshelfItem(item: BookshelfItem): void {
    this.bookshelfOpen.set(false);
    // The stored identifier is a DOI / arXiv / S2 / OpenAlex id (or the CSV
    // UUID in demo mode), each of which the matching builder resolves directly.
    this.paperId.set(item.paper_identifier);
    this.buildGraph();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.bookshelfOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.bookshelfOpen.set(false);
    }
  }

  private runLayout(data: CitGraphResponse): void {
    const nodes: LayoutNode[] = data.nodes.map((n, i) => ({
      id: n.paper_id,
      data: n,
      x: 400 + (Math.random() - 0.5) * 300,
      y: 300 + (Math.random() - 0.5) * 200,
      vx: 0,
      vy: 0,
      community: 0,
    }));

    const seedIdx = nodes.findIndex(n => n.id === data.seed_id);
    if (seedIdx >= 0) {
      nodes[seedIdx].x = 400;
      nodes[seedIdx].y = 300;
    }

    const idxMap = new Map(nodes.map((n, i) => [n.id, i]));

    const iterations = 120;
    const repulsion = 5000;
    const attraction = 0.005;
    const damping = 0.9;
    const centerGravity = 0.01;
    const cx = 400, cy = 300;

    for (let iter = 0; iter < iterations; iter++) {
      const temp = 1 - iter / iterations;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (repulsion * temp) / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx -= fx;
          nodes[i].vy -= fy;
          nodes[j].vx += fx;
          nodes[j].vy += fy;
        }
      }

      for (const edge of data.edges) {
        const si = idxMap.get(edge.source);
        const ti = idxMap.get(edge.target);
        if (si === undefined || ti === undefined) continue;
        const dx = nodes[ti].x - nodes[si].x;
        const dy = nodes[ti].y - nodes[si].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * attraction;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[si].vx += fx;
        nodes[si].vy += fy;
        nodes[ti].vx -= fx;
        nodes[ti].vy -= fy;
      }

      for (const node of nodes) {
        node.vx += (cx - node.x) * centerGravity;
        node.vy += (cy - node.y) * centerGravity;
        node.vx *= damping;
        node.vy *= damping;
        const maxV = 20 * temp + 1;
        const v = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
        if (v > maxV) {
          node.vx = (node.vx / v) * maxV;
          node.vy = (node.vy / v) * maxV;
        }
        node.x += node.vx;
        node.y += node.vy;
      }
    }

    const minX = Math.min(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    for (const n of nodes) {
      n.x -= minX - 80;
      n.y -= minY - 80;
    }

    this.layoutNodes.set(nodes);
  }

  runLouvain(): void {
    const data = this.graphData();
    if (!data) return;
    const nodes = this.layoutNodes();
    const idxMap = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = data.edges
      .map(e => ({
        source: idxMap.get(e.source) ?? -1,
        target: idxMap.get(e.target) ?? -1,
      }))
      .filter(e => e.source >= 0 && e.target >= 0);

    const result = louvain(nodes.length, edges, {
      resolution: this.resolution(),
      maxLevels: this.maxLevels(),
    });
    this.louvainResult.set(result);
    // Default to level 1 — the finest detected communities — so clusters are
    // visible immediately. Level 0 (no clusters) remains selectable.
    this.louvainLevel.set(result.levels.length ? 1 : 0);
    this.selectedClusterId.set(null);

    // Group the layout by the finest communities so nested hulls stay tidy at
    // every level (coarser hulls then naturally enclose the finer ones).
    const comm = result.levels.length
      ? getCommunitiesAtLevel(result.levels, nodes.length, 0)
      : nodes.map((_, i) => i);
    const updated = nodes.map((n, i) => ({ ...n, community: comm[i] }));

    const commCenters = new Map<number, { sx: number; sy: number; count: number }>();
    for (const n of updated) {
      const c = commCenters.get(n.community) ?? { sx: 0, sy: 0, count: 0 };
      c.sx += n.x; c.sy += n.y; c.count++;
      commCenters.set(n.community, c);
    }

    for (let iter = 0; iter < 30; iter++) {
      for (const n of updated) {
        const c = commCenters.get(n.community)!;
        const ccx = c.sx / c.count;
        const ccy = c.sy / c.count;
        n.x += (ccx - n.x) * 0.03;
        n.y += (ccy - n.y) * 0.03;
      }
    }

    this.layoutNodes.set(updated);
  }

  changeLouvainLevel(level: number): void {
    const result = this.louvainResult();
    if (!result) return;
    // Levels are precomputed: switching is a pure re-color of the existing
    // hierarchy, no recomputation. Cluster ids differ per level, so any open
    // cluster inspection is cleared. Display level 0 shows no clusters; level
    // L (≥1) shows hierarchy index L-1.
    this.louvainLevel.set(level);
    this.selectedClusterId.set(null);
    this.selectedNodeId.set(null);
    if (level >= 1) {
      const comm = getCommunitiesAtLevel(result.levels, this.layoutNodes().length, level - 1);
      const updated = this.layoutNodes().map((n, i) => ({ ...n, community: comm[i] }));
      this.layoutNodes.set(updated);
    }
  }

  inspectCluster(clusterId: number): void {
    this.selectedClusterId.set(this.selectedClusterId() === clusterId ? null : clusterId);
    if (this.selectedClusterId() !== null) this.selectedNodeId.set(null);
  }

  closeClusterPanel(): void {
    this.selectedClusterId.set(null);
  }

  onNodeClick(node: DisplayNode): void {
    if (node.kind === 'cluster' && node.clusterId !== null) {
      this.inspectCluster(node.clusterId);
    } else {
      this.selectedNodeId.set(this.selectedNodeId() === node.id ? null : node.id);
      if (this.selectedNodeId() !== null) this.selectedClusterId.set(null);
    }
  }

  edgePath(edge: DisplayEdge): string {
    const pos = this.displayNodePos();
    const from = pos.get(edge.source);
    const to = pos.get(edge.target);
    if (!from || !to) return '';
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  isEdgeHighlighted(edge: DisplayEdge): boolean {
    const a = this.activeDisplayId();
    if (!a) return false;
    return edge.source === a || edge.target === a;
  }

  isNodeDimmed(node: DisplayNode): boolean {
    const a = this.activeDisplayId();
    if (!a) return false;
    return node.id !== a && !this.activeNeighbors().has(node.id);
  }

  authorLine(node: CitGraphNode): string {
    const a = node.authors;
    if (!a.length) return '';
    const names = a.slice(0, 3);
    return a.length > 3 ? names.join(', ') + ' et al.' : names.join(', ');
  }

  closePanel(): void {
    this.selectedNodeId.set(null);
  }

  zoomIn(): void {
    this.zoom.update(z => Math.min(z + CitGraphComponent.ZOOM_STEP, CitGraphComponent.ZOOM_MAX));
  }

  zoomOut(): void {
    this.zoom.update(z => Math.max(z - CitGraphComponent.ZOOM_STEP, CitGraphComponent.ZOOM_MIN));
  }

  resetZoom(): void {
    this.zoom.set(1);
  }

  get zoomPercent(): number {
    return Math.round(this.zoom() * 100);
  }

  onCanvasWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = -Math.sign(event.deltaY) * CitGraphComponent.ZOOM_STEP;
    this.zoom.update(z =>
      Math.min(Math.max(z + delta, CitGraphComponent.ZOOM_MIN), CitGraphComponent.ZOOM_MAX)
    );
  }

  sendRepresentativesToGraph(): void {
    const result = this.louvainResult();
    if (!result || result.levels.length === 0) {
      this.notify.show('Run Louvain clustering first');
      return;
    }

    // Hand the OK-Graph the full hierarchy (base nodes in Louvain index order +
    // the dendrogram); it computes representatives and drills down itself.
    const baseNodes = this.layoutNodes().map(n => n.data);
    this.okGraphState.setHierarchy(baseNodes, result);
    this.notify.show('Sent cluster hierarchy to OK-Graph');

    const projectId = this.projectContext.activeProjectId();
    if (projectId !== null) {
      this.router.navigate(['/dashboard', projectId, 'graph', 'ok']);
    }
  }
}

function hopColor(hop: number): string {
  const colors = ['#2563eb', '#7c3aed', '#dc2626', '#d97706', '#6b7280'];
  return colors[Math.min(hop, colors.length - 1)];
}

function truncate(title: string): string {
  return title.length > 22 ? title.slice(0, 20) + '...' : title;
}

// Resolve overlaps between collapsed cluster meta-nodes by pushing any pair
// closer than their combined radii apart. Deterministic given the input.
function spreadClusterNodes(nodes: DisplayNode[]): void {
  const pad = 26;
  for (let iter = 0; iter < 80; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const min = a.radius + b.radius + pad;
        if (dist < min) {
          const push = (min - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}
