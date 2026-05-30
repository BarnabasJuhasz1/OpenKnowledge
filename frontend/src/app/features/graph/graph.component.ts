import { Component, computed, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchStateService, paperId as servicePaperId } from '../../core/services/search-state.service';
import { Paper } from '../../core/models/paper.model';
import { BookshelfService } from '../../core/services/bookshelf.service';
import { NotificationService } from '../../core/services/notification.service';
import { getArchetypeIcon } from '../../shared/utils/archetype-icons';

export interface GraphNode {
  id: string;
  paper: Paper;
  x: number;
  y: number;
  year: number;
  letter: string;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
}

interface YearColumn {
  year: number;
  x: number;
}

interface Divider {
  x: number;
}

const NODE_RADIUS = 22;
const YEAR_GAP = 180;
const VERTICAL_GAP = 90;
const TOP_PADDING = 60;
const LEFT_PADDING = 80;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function paperId(p: Paper): string {
  return p.doi || p.arxiv_id || p.semantic_scholar_id || p.openalex_id || p.title;
}

function paperIdentifiers(p: Paper): Set<string> {
  const ids = new Set<string>();
  if (p.doi) ids.add(p.doi.toLowerCase());
  if (p.arxiv_id) ids.add(p.arxiv_id.toLowerCase());
  if (p.semantic_scholar_id) ids.add(p.semantic_scholar_id.toLowerCase());
  if (p.openalex_id) ids.add(p.openalex_id.toLowerCase());
  if (p.pubmed_id) ids.add(p.pubmed_id.toLowerCase());
  return ids;
}

export interface ExpandPopup {
  nodeId: string;
  direction: 'past' | 'future';
  papers: { paper: Paper; id: string }[];
  x: number;
  y: number;
}

@Component({
  selector: 'app-graph',
  standalone: true,
  imports: [DecimalPipe, FormsModule],
  templateUrl: './graph.component.html',
  styleUrl: './graph.component.scss',
})
export class GraphComponent {
  readonly state = inject(SearchStateService);
  private readonly bookshelfSvc = inject(BookshelfService);
  private readonly notify = inject(NotificationService);

  getArchetypeIcon(archetype?: string | null): string {
    return getArchetypeIcon(archetype);
  }

  readonly selectedNodeId = signal<string | null>(null);
  readonly hoveredNodeId = signal<string | null>(null);
  readonly panelCollapsed = signal(false);
  readonly TOP_PADDING = TOP_PADDING;
  readonly zoom = signal(1);
  readonly expandPopup = signal<ExpandPopup | null>(null);

  private static readonly ZOOM_MIN = 0.3;
  private static readonly ZOOM_MAX = 2;
  private static readonly ZOOM_STEP = 0.15;

  addNodeQuery = '';
  addNodeError = signal<string | null>(null);
  selectedBookmarked = signal(false);

  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private expandClickTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    effect(() => {
      const papers = this.state.allScoredPapers();
      if (papers.length > 0 && !this.state.graphInitialized) {
        this.state.graphInitialized = true;
        const top5 = [...papers]
          .filter(p => p.year != null)
          .sort((a, b) => (b.ok_score ?? 0) - (a.ok_score ?? 0))
          .slice(0, 5)
          .map(p => paperId(p));
        // Preserve any papers placed directly onto the graph (e.g. cit-graph
        // representatives) so the auto top-5 seed doesn't wipe them out.
        const external = [...this.state.externalGraphPapers().keys()];
        this.state.graphPaperIds.set(new Set([...top5, ...external]));
      }
    });
  }

  private readonly graphPapers = computed(() => {
    const ids = this.state.graphPaperIds();
    const all = this.state.allScoredPapers();
    const external = this.state.externalGraphPapers();
    const idMap = new Map(all.map(p => [paperId(p), p]));
    for (const [id, p] of external) idMap.set(id, p);
    const result: Paper[] = [];
    for (const id of ids) {
      const p = idMap.get(id);
      if (p && p.year != null) result.push(p);
    }
    return result;
  });

  readonly yearColumns = computed<YearColumn[]>(() => {
    const papers = this.graphPapers();
    const years = [...new Set(papers.map(p => p.year!))].sort((a, b) => a - b);
    return years.map((year, i) => ({
      year,
      x: LEFT_PADDING + i * YEAR_GAP,
    }));
  });

  readonly dividers = computed<Divider[]>(() => {
    const cols = this.yearColumns();
    const result: Divider[] = [];
    for (let i = 0; i < cols.length - 1; i++) {
      result.push({ x: (cols[i].x + cols[i + 1].x) / 2 });
    }
    return result;
  });

  readonly nodes = computed<GraphNode[]>(() => {
    const papers = this.graphPapers();
    const columns = this.yearColumns();
    const yearX = new Map(columns.map(c => [c.year, c.x]));
    const years = columns.map(c => c.year);

    const initial: GraphNode[] = papers.map((p, i) => {
      const letter = i < LETTERS.length ? LETTERS[i] : `${i + 1}`;
      return {
        id: paperId(p),
        paper: p,
        x: yearX.get(p.year!) ?? LEFT_PADDING,
        y: 0,
        year: p.year!,
        letter,
      };
    });

    const byYear = new Map<number, GraphNode[]>();
    for (const n of initial) {
      let arr = byYear.get(n.year);
      if (!arr) { arr = []; byYear.set(n.year, arr); }
      arr.push(n);
    }

    const idToNode = new Map<string, GraphNode>();
    for (const n of initial) {
      for (const id of paperIdentifiers(n.paper)) idToNode.set(id, n);
    }

    const adj = new Map<string, Set<string>>();
    for (const n of initial) {
      if (!adj.has(n.id)) adj.set(n.id, new Set());
      for (const ref of (n.paper.references ?? [])) {
        const t = idToNode.get(ref.toLowerCase());
        if (t && t.id !== n.id) {
          adj.get(n.id)!.add(t.id);
          if (!adj.has(t.id)) adj.set(t.id, new Set());
          adj.get(t.id)!.add(n.id);
        }
      }
      for (const ref of (n.paper.referenced_by ?? [])) {
        const s = idToNode.get(ref.toLowerCase());
        if (s && s.id !== n.id) {
          adj.get(n.id)!.add(s.id);
          if (!adj.has(s.id)) adj.set(s.id, new Set());
          adj.get(s.id)!.add(n.id);
        }
      }
    }

    for (const [, col] of byYear) {
      col.forEach((n, i) => { n.y = TOP_PADDING + 40 + i * VERTICAL_GAP; });
    }

    const nodeById = new Map(initial.map(n => [n.id, n]));
    const ITERATIONS = 4;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const yearOrder = iter % 2 === 0 ? years : [...years].reverse();
      for (const yr of yearOrder) {
        const col = byYear.get(yr);
        if (!col || col.length < 2) continue;
        for (const n of col) {
          const neighbors = adj.get(n.id);
          if (!neighbors || neighbors.size === 0) continue;
          let sum = 0, count = 0;
          for (const nid of neighbors) {
            const nb = nodeById.get(nid);
            if (nb && nb.year !== yr) { sum += nb.y; count++; }
          }
          if (count > 0) n.y = sum / count;
        }
        col.sort((a, b) => a.y - b.y);
        col.forEach((n, i) => { n.y = TOP_PADDING + 40 + i * VERTICAL_GAP; });
      }
    }

    return initial;
  });

  readonly edges = computed<GraphEdge[]>(() => {
    const nodes = this.nodes();
    const idToNode = new Map<string, GraphNode>();
    for (const node of nodes) {
      for (const id of paperIdentifiers(node.paper)) {
        idToNode.set(id, node);
      }
    }

    const seen = new Set<string>();
    const result: GraphEdge[] = [];

    for (const node of nodes) {
      for (const ref of (node.paper.references ?? [])) {
        const target = idToNode.get(ref.toLowerCase());
        if (target && target.id !== node.id) {
          const key = `${node.id}→${target.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ fromId: node.id, toId: target.id });
          }
        }
      }
      for (const ref of (node.paper.referenced_by ?? [])) {
        const source = idToNode.get(ref.toLowerCase());
        if (source && source.id !== node.id) {
          const key = `${source.id}→${node.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ fromId: source.id, toId: node.id });
          }
        }
      }
    }
    return result;
  });

  private readonly nodeMap = computed(() => new Map(this.nodes().map(n => [n.id, n])));

  readonly svgWidth = computed(() => {
    const cols = this.yearColumns();
    return cols.length > 0
      ? cols[cols.length - 1].x + LEFT_PADDING + 40
      : 400;
  });

  readonly svgHeight = computed(() => {
    const nodes = this.nodes();
    if (!nodes.length) return 300;
    const maxY = Math.max(...nodes.map(n => n.y));
    return maxY + VERTICAL_GAP + 20;
  });

  readonly selectedPaper = computed<Paper | null>(() => {
    const id = this.selectedNodeId();
    if (!id) return null;
    return this.nodeMap().get(id)?.paper ?? null;
  });

  readonly selectedLetter = computed<string>(() => {
    const id = this.selectedNodeId();
    if (!id) return '';
    return this.nodeMap().get(id)?.letter ?? '';
  });

  /** BFS depth backward through reference chains only. depth 1 = directly cited by selected, 2+ = transitive. */
  readonly ancestorDepth = computed<Map<string, number>>(() => {
    const sel = this.selectedNodeId();
    if (!sel) return new Map();
    const nMap = this.nodeMap();
    const selNode = nMap.get(sel);
    if (!selNode) return new Map();

    const idToNode = new Map<string, GraphNode>();
    for (const n of this.nodes()) {
      for (const id of paperIdentifiers(n.paper)) {
        idToNode.set(id, n);
      }
    }

    const depth = new Map<string, number>();
    const queue: { id: string; d: number }[] = [];

    for (const ref of (selNode.paper.references ?? [])) {
      const target = idToNode.get(ref.toLowerCase());
      if (target && target.id !== sel && !depth.has(target.id)) {
        depth.set(target.id, 1);
        queue.push({ id: target.id, d: 1 });
      }
    }

    let qi = 0;
    while (qi < queue.length) {
      const { id: curId, d } = queue[qi++];
      const curNode = nMap.get(curId);
      if (!curNode) continue;
      for (const ref of (curNode.paper.references ?? [])) {
        const target = idToNode.get(ref.toLowerCase());
        if (target && target.id !== sel && !depth.has(target.id)) {
          depth.set(target.id, d + 1);
          queue.push({ id: target.id, d: d + 1 });
        }
      }
    }

    return depth;
  });

  // --- Actions ---

  readonly canExpandSelected = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return false;
    const node = this.nodeMap().get(id);
    if (!node) return false;
    return this.hasExpandablePapers(node);
  });

  selectNode(node: GraphNode): void {
    this.expandPopup.set(null);
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      const newId = this.selectedNodeId() === node.id ? null : node.id;
      this.selectedNodeId.set(newId);
      if (newId) this.checkBookmarkStatus(paperId(node.paper));
    }, 250);
  }

  onNodeDblClick(node: GraphNode, event: MouseEvent): void {
    event.stopPropagation();
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.selectedNodeId.set(node.id);
    this.expandPast(node, 2);
    this.expandFuture(node, 2);
  }

  expandPast(node: GraphNode, limit = 1): void {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const cited: Paper[] = [];
    for (const p of allPapers) {
      if (currentIds.has(paperId(p))) continue;
      const pIds = paperIdentifiers(p);
      const refs = node.paper.references ?? [];
      if (refs.some(r => pIds.has(r.toLowerCase()))) {
        cited.push(p);
      }
    }
    cited.sort((a, b) => (b.ok_score ?? 0) - (a.ok_score ?? 0));
    const toAdd = cited.slice(0, limit).map(p => paperId(p));
    if (toAdd.length > 0) {
      this.state.graphPaperIds.update(prev => {
        const next = new Set(prev);
        for (const id of toAdd) next.add(id);
        return next;
      });
    }
  }

  expandFuture(node: GraphNode, limit = 1): void {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const nodeIds = paperIdentifiers(node.paper);
    const citing: Paper[] = [];
    for (const p of allPapers) {
      if (currentIds.has(paperId(p))) continue;
      const refs = p.references ?? [];
      if (refs.some(r => nodeIds.has(r.toLowerCase()))) {
        citing.push(p);
      }
    }
    citing.sort((a, b) => (b.ok_score ?? 0) - (a.ok_score ?? 0));
    const toAdd = citing.slice(0, limit).map(p => paperId(p));
    if (toAdd.length > 0) {
      this.state.graphPaperIds.update(prev => {
        const next = new Set(prev);
        for (const id of toAdd) next.add(id);
        return next;
      });
    }
  }

  expandNodePastDbl(node: GraphNode, event: MouseEvent): void {
    event.stopPropagation();
    const key = `past-${node.id}`;
    const timer = this.expandClickTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.expandClickTimers.delete(key);
    }
    this.expandPopup.set(null);
    this.selectedNodeId.set(node.id);
    this.expandPast(node);
  }

  expandNodeFutureDbl(node: GraphNode, event: MouseEvent): void {
    event.stopPropagation();
    const key = `future-${node.id}`;
    const timer = this.expandClickTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.expandClickTimers.delete(key);
    }
    this.expandPopup.set(null);
    this.selectedNodeId.set(node.id);
    this.expandFuture(node);
  }

  onExpandArrowClick(node: GraphNode, direction: 'past' | 'future', event: MouseEvent): void {
    event.stopPropagation();
    const key = `${direction}-${node.id}`;
    const existing = this.expandClickTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.expandClickTimers.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      this.expandClickTimers.delete(key);
      this.selectedNodeId.set(node.id);
      this.showExpandPopup(node, direction);
    }, 250);
    this.expandClickTimers.set(key, timer);
  }

  private showExpandPopup(node: GraphNode, direction: 'past' | 'future'): void {
    const papers = direction === 'past'
      ? this.getExpandablePapersPast(node)
      : this.getExpandablePapersFuture(node);
    if (!papers.length) return;
    const offsetX = direction === 'past' ? node.x - 34 : node.x + 34;
    this.expandPopup.set({
      nodeId: node.id,
      direction,
      papers,
      x: offsetX * this.zoom(),
      y: (node.y + 16) * this.zoom(),
    });
  }

  getExpandablePapersPast(node: GraphNode): { paper: Paper; id: string }[] {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const refs = node.paper.references ?? [];
    if (!refs.length) return [];
    const result: { paper: Paper; id: string }[] = [];
    for (const p of allPapers) {
      const pid = paperId(p);
      if (currentIds.has(pid)) continue;
      const pIds = paperIdentifiers(p);
      if (refs.some(r => pIds.has(r.toLowerCase()))) {
        result.push({ paper: p, id: pid });
      }
    }
    result.sort((a, b) => (b.paper.ok_score ?? 0) - (a.paper.ok_score ?? 0));
    return result;
  }

  getExpandablePapersFuture(node: GraphNode): { paper: Paper; id: string }[] {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const nodeIds = paperIdentifiers(node.paper);
    const result: { paper: Paper; id: string }[] = [];
    for (const p of allPapers) {
      const pid = paperId(p);
      if (currentIds.has(pid)) continue;
      const refs = p.references ?? [];
      if (refs.some(r => nodeIds.has(r.toLowerCase()))) {
        result.push({ paper: p, id: pid });
      }
    }
    result.sort((a, b) => (b.paper.ok_score ?? 0) - (a.paper.ok_score ?? 0));
    return result;
  }

  addPaperFromPopup(item: { paper: Paper; id: string }): void {
    this.state.graphPaperIds.update(prev => new Set([...prev, item.id]));
    this.expandPopup.set(null);
  }

  closeExpandPopup(): void {
    this.expandPopup.set(null);
  }

  expandSelectedNode(): void {
    const id = this.selectedNodeId();
    if (!id) return;
    const node = this.nodeMap().get(id);
    if (!node) return;
    this.expandPast(node, 2);
    this.expandFuture(node, 2);
  }

  removeSelectedNode(): void {
    const id = this.selectedNodeId();
    if (!id) return;
    this.selectedNodeId.set(null);
    this.state.removeFromGraph(id);
  }

  canExpandPast(node: GraphNode): boolean {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const refs = node.paper.references ?? [];
    if (!refs.length) return false;
    for (const p of allPapers) {
      if (currentIds.has(paperId(p))) continue;
      const pIds = paperIdentifiers(p);
      if (refs.some(r => pIds.has(r.toLowerCase()))) return true;
    }
    return false;
  }

  canExpandFuture(node: GraphNode): boolean {
    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const currentIds = this.state.graphPaperIds();
    const nodeIds = paperIdentifiers(node.paper);
    for (const p of allPapers) {
      if (currentIds.has(paperId(p))) continue;
      const refs = p.references ?? [];
      if (refs.some(r => nodeIds.has(r.toLowerCase()))) return true;
    }
    return false;
  }

  private hasExpandablePapers(node: GraphNode): boolean {
    return this.canExpandPast(node) || this.canExpandFuture(node);
  }

  clearGraph(): void {
    this.state.flushGraph();
    this.selectedNodeId.set(null);
  }

  addNodeByTitle(): void {
    const q = this.addNodeQuery.trim().toLowerCase();
    if (!q) return;
    this.addNodeError.set(null);

    const allPapers = this.state.allScoredPapers().filter(p => p.year != null);
    const match = allPapers.find(p => p.title.toLowerCase().includes(q));

    if (!match) {
      this.addNodeError.set('No matching paper found among retrieved results.');
      return;
    }

    const id = paperId(match);
    if (this.state.graphPaperIds().has(id)) {
      this.addNodeError.set('This paper is already on the graph.');
      return;
    }

    this.state.graphPaperIds.update(prev => new Set([...prev, id]));
    this.addNodeQuery = '';
  }

  // --- SVG helpers ---

  showExpandButtons(node: GraphNode): boolean {
    return this.selectedNodeId() === node.id || this.hoveredNodeId() === node.id;
  }

  onNodeEnter(node: GraphNode): void {
    this.hoveredNodeId.set(node.id);
  }

  onNodeLeave(): void {
    this.hoveredNodeId.set(null);
  }

  isSelected(node: GraphNode): boolean {
    return this.selectedNodeId() === node.id;
  }

  togglePanel(): void {
    this.panelCollapsed.update(v => !v);
  }

  isConnected(node: GraphNode): boolean {
    const sel = this.selectedNodeId();
    if (!sel) return false;
    return this.edges().some(
      e => (e.fromId === sel && e.toId === node.id)
        || (e.toId === sel && e.fromId === node.id),
    );
  }

  isAncestor(node: GraphNode): boolean {
    return this.ancestorDepth().has(node.id);
  }

  isTransitive(node: GraphNode): boolean {
    return (this.ancestorDepth().get(node.id) ?? 0) > 1;
  }

  nodeOpacity(node: GraphNode): number {
    const d = this.ancestorDepth().get(node.id) ?? 0;
    if (d <= 1) return 1;
    return Math.max(0.25, 1 - (d - 1) * 0.2);
  }

  isEdgeHighlighted(edge: GraphEdge): boolean {
    const sel = this.selectedNodeId();
    if (!sel) return false;
    return edge.fromId === sel || edge.toId === sel;
  }

  isEdgeInAncestorChain(edge: GraphEdge): boolean {
    const sel = this.selectedNodeId();
    if (!sel) return false;
    const depth = this.ancestorDepth();
    const fromIsAncestor = depth.has(edge.fromId) || edge.fromId === sel;
    const toIsAncestor = depth.has(edge.toId) || edge.toId === sel;
    return fromIsAncestor && toIsAncestor;
  }

  edgePath(edge: GraphEdge): string {
    const from = this.nodeMap().get(edge.fromId);
    const to = this.nodeMap().get(edge.toId);
    if (!from || !to) return '';
    const dx = to.x - from.x;
    if (Math.abs(dx) < 10) {
      return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    }
    const cx = (from.x + to.x) / 2;
    return `M ${from.x} ${from.y} C ${cx} ${from.y}, ${cx} ${to.y}, ${to.x} ${to.y}`;
  }

  nodeLabel(node: GraphNode): string {
    const t = node.paper.title;
    return t.length > 28 ? t.slice(0, 26) + '…' : t;
  }

  authorLine(paper: Paper): string {
    const a = paper.authors;
    if (!a?.length) return '';
    const names = a.slice(0, 5).map(x => x.name);
    return a.length > 5 ? names.join(', ') + ' et al.' : names.join(', ');
  }

  retrievedCitationCount(paper: Paper): number {
    const refdBy = paper.referenced_by ?? [];
    if (!refdBy.length) return 0;
    const refdBySet = new Set(refdBy.map(r => r.toLowerCase()));
    const allPapers = this.state.allScoredPapers();
    let count = 0;
    for (const p of allPapers) {
      for (const id of paperIdentifiers(p)) {
        if (refdBySet.has(id)) { count++; break; }
      }
    }
    return count;
  }

  retrievedReferenceCount(paper: Paper): number {
    const refs = paper.references ?? [];
    if (!refs.length) return 0;
    const refsSet = new Set(refs.map(r => r.toLowerCase()));
    const allPapers = this.state.allScoredPapers();
    let count = 0;
    for (const p of allPapers) {
      for (const id of paperIdentifiers(p)) {
        if (refsSet.has(id)) { count++; break; }
      }
    }
    return count;
  }

  closePanel(): void {
    this.selectedNodeId.set(null);
  }

  toggleBookshelf(): void {
    const paper = this.selectedPaper();
    if (!paper) return;
    const pid = paperId(paper);
    if (this.selectedBookmarked()) {
      this.bookshelfSvc.check(pid).subscribe({
        next: (res) => {
          if (res.id) {
            this.bookshelfSvc.remove(res.id).subscribe({
              next: () => {
                this.selectedBookmarked.set(false);
                this.notify.show('Removed from bookshelf');
              },
            });
          }
        },
      });
    } else {
      this.bookshelfSvc.add({
        paper_identifier: pid,
        title: paper.title,
        authors: paper.authors.map(a => a.name),
        year: paper.year,
        paper: paper,
      }).subscribe({
        next: () => {
          this.selectedBookmarked.set(true);
          this.notify.show('Added to bookshelf');
        },
        error: () => this.selectedBookmarked.set(true),
      });
    }
  }

  private checkBookmarkStatus(pid: string): void {
    this.bookshelfSvc.check(pid).subscribe({
      next: (res) => this.selectedBookmarked.set(res.bookmarked),
      error: () => this.selectedBookmarked.set(false),
    });
  }

  zoomIn(): void {
    this.zoom.update(z => Math.min(z + GraphComponent.ZOOM_STEP, GraphComponent.ZOOM_MAX));
  }

  zoomOut(): void {
    this.zoom.update(z => Math.max(z - GraphComponent.ZOOM_STEP, GraphComponent.ZOOM_MIN));
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
    const delta = -Math.sign(event.deltaY) * GraphComponent.ZOOM_STEP;
    this.zoom.update(z =>
      Math.min(Math.max(z + delta, GraphComponent.ZOOM_MIN), GraphComponent.ZOOM_MAX)
    );
  }
}
