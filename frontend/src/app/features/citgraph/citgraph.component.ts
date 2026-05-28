import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CitGraphService, CitGraphNode, CitGraphEdge, CitGraphResponse } from '../../core/services/citgraph.service';
import { louvain, getCommunitiesAtLevel, LouvainResult } from './louvain';

interface LayoutNode {
  id: string;
  data: CitGraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  community: number;
}

const COMMUNITY_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
  '#db2777', '#0891b2', '#65a30d', '#ea580c', '#4f46e5',
  '#be123c', '#0d9488', '#b45309', '#7e22ce', '#c2410c',
];

@Component({
  selector: 'app-citgraph',
  standalone: true,
  imports: [RouterLink, DecimalPipe, FormsModule],
  templateUrl: './citgraph.component.html',
  styleUrl: './citgraph.component.scss',
})
export class CitGraphComponent {
  private readonly citgraphSvc = inject(CitGraphService);

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
  readonly louvainLevel = signal(0);
  readonly showCommunities = signal(false);

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

  readonly hullPaths = computed(() => {
    if (!this.showCommunities()) return [];
    const nodes = this.layoutNodes();
    const byComm = new Map<number, LayoutNode[]>();
    for (const n of nodes) {
      let arr = byComm.get(n.community);
      if (!arr) { arr = []; byComm.set(n.community, arr); }
      arr.push(n);
    }
    const hulls: { path: string; color: string }[] = [];
    for (const [cid, members] of byComm) {
      if (members.length < 3) continue;
      const points = members.map(n => ({ x: n.x, y: n.y }));
      const hull = convexHull(points);
      const expanded = expandHull(hull, 30);
      const path = hullToSmoothPath(expanded);
      hulls.push({
        path,
        color: COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length],
      });
    }
    return hulls;
  });

  readonly svgWidth = computed(() => {
    const nodes = this.layoutNodes();
    if (!nodes.length) return 800;
    return Math.max(800, Math.max(...nodes.map(n => n.x)) + 100);
  });

  readonly svgHeight = computed(() => {
    const nodes = this.layoutNodes();
    if (!nodes.length) return 600;
    return Math.max(600, Math.max(...nodes.map(n => n.y)) + 100);
  });

  buildGraph(): void {
    const id = this.paperId().trim();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.graphData.set(null);
    this.louvainResult.set(null);
    this.showCommunities.set(false);
    this.selectedNodeId.set(null);

    this.citgraphSvc.build(id, this.kHops(), this.maxPerHop()).subscribe({
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

    const result = louvain(nodes.length, edges);
    this.louvainResult.set(result);
    this.louvainLevel.set(0);
    this.showCommunities.set(true);

    const comm = result.communities;
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
    if (!result || result.levels.length === 0) return;
    this.louvainLevel.set(level);
    const comm = getCommunitiesAtLevel(result.levels, this.layoutNodes().length, level);
    const updated = this.layoutNodes().map((n, i) => ({ ...n, community: comm[i] }));
    this.layoutNodes.set(updated);
  }

  selectNode(node: LayoutNode): void {
    this.selectedNodeId.set(this.selectedNodeId() === node.id ? null : node.id);
  }

  nodeColor(node: LayoutNode): string {
    if (this.selectedNodeId() === node.id) return '#2563eb';
    if (this.showCommunities()) {
      return COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length];
    }
    return hopColor(node.data.hop);
  }

  nodeRadius(node: LayoutNode): number {
    const data = this.graphData();
    if (data && node.id === data.seed_id) return 18;
    return 12;
  }

  edgePath(edge: { source: string; target: string }): string {
    const nodes = this.layoutNodes();
    const from = nodes.find(n => n.id === edge.source);
    const to = nodes.find(n => n.id === edge.target);
    if (!from || !to) return '';
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  isEdgeHighlighted(edge: { source: string; target: string }): boolean {
    const sel = this.selectedNodeId();
    if (!sel) return false;
    return edge.source === sel || edge.target === sel;
  }

  nodeLabel(node: LayoutNode): string {
    const t = node.data.title;
    return t.length > 22 ? t.slice(0, 20) + '...' : t;
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
}

function hopColor(hop: number): string {
  const colors = ['#2563eb', '#7c3aed', '#dc2626', '#d97706', '#6b7280'];
  return colors[Math.min(hop, colors.length - 1)];
}

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function expandHull(hull: { x: number; y: number }[], padding: number): { x: number; y: number }[] {
  if (hull.length < 3) return hull;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: p.x + (dx / dist) * padding, y: p.y + (dy / dist) * padding };
  });
}

function hullToSmoothPath(hull: { x: number; y: number }[]): string {
  if (hull.length < 3) return '';
  const pts = [...hull, hull[0], hull[1]];
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < hull.length; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const p2 = pts[i + 2];
    const cx1 = p0.x + (p1.x - p0.x) * 0.5;
    const cy1 = p0.y + (p1.y - p0.y) * 0.5;
    const cx2 = p1.x + (p2.x - p1.x) * 0.5;
    const cy2 = p1.y + (p2.y - p1.y) * 0.5;
    d += ` Q ${p1.x} ${p1.y} ${(cx1 + cx2) / 2} ${(cy1 + cy2) / 2}`;
  }
  d += ' Z';
  return d;
}
