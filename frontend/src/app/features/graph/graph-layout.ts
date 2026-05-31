import { Paper } from '../../core/models/paper.model';

/**
 * Year-distributed graph layout, extracted from the Graph view so other views
 * (e.g. OK-Graph) can reuse the exact same look. Unlike the Graph component
 * (which derives adjacency from paper references), this takes an explicit edge
 * list, so it can lay out any node/edge set.
 */

export interface LayoutItem {
  id: string;
  paper: Paper;
  year: number;
}

export interface LaidOutNode extends LayoutItem {
  x: number;
  y: number;
  letter: string;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
}

export interface YearColumn {
  year: number;
  x: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LayoutEdge[];
  yearColumns: YearColumn[];
  dividers: { x: number }[];
  width: number;
  height: number;
}

export const NODE_RADIUS = 22;
const YEAR_GAP = 180;
const VERTICAL_GAP = 90;
export const TOP_PADDING = 60;
const LEFT_PADDING = 80;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function layoutByYear(items: LayoutItem[], edges: LayoutEdge[]): GraphLayout {
  const withYear = items.filter(it => it.year != null);

  const years = [...new Set(withYear.map(it => it.year))].sort((a, b) => a - b);
  const yearColumns: YearColumn[] = years.map((year, i) => ({
    year,
    x: LEFT_PADDING + i * YEAR_GAP,
  }));
  const yearX = new Map(yearColumns.map(c => [c.year, c.x]));

  const nodes: LaidOutNode[] = withYear.map((it, i) => ({
    ...it,
    letter: i < LETTERS.length ? LETTERS[i] : `${i + 1}`,
    x: yearX.get(it.year) ?? LEFT_PADDING,
    y: 0,
  }));

  // Group nodes by year column.
  const byYear = new Map<number, LaidOutNode[]>();
  for (const n of nodes) {
    let arr = byYear.get(n.year);
    if (!arr) { arr = []; byYear.set(n.year, arr); }
    arr.push(n);
  }

  // Build adjacency from the explicit edges (only between known nodes).
  const known = new Set(nodes.map(n => n.id));
  const adj = new Map<string, Set<string>>();
  const validEdges: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.fromId) || !known.has(e.toId) || e.fromId === e.toId) continue;
    const key = e.fromId < e.toId ? `${e.fromId}|${e.toId}` : `${e.toId}|${e.fromId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validEdges.push(e);
    if (!adj.has(e.fromId)) adj.set(e.fromId, new Set());
    if (!adj.has(e.toId)) adj.set(e.toId, new Set());
    adj.get(e.fromId)!.add(e.toId);
    adj.get(e.toId)!.add(e.fromId);
  }

  // Initial vertical stacking within each column.
  for (const [, col] of byYear) {
    col.forEach((n, i) => { n.y = TOP_PADDING + 40 + i * VERTICAL_GAP; });
  }

  // Barycentric ordering: pull each node toward the mean y of its cross-column
  // neighbours, then restack. A few sweeps reduce edge crossings.
  const nodeById = new Map(nodes.map(n => [n.id, n]));
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

  const dividers: { x: number }[] = [];
  for (let i = 0; i < yearColumns.length - 1; i++) {
    dividers.push({ x: (yearColumns[i].x + yearColumns[i + 1].x) / 2 });
  }

  const width = yearColumns.length > 0
    ? yearColumns[yearColumns.length - 1].x + LEFT_PADDING + 40
    : 400;
  const height = nodes.length
    ? Math.max(...nodes.map(n => n.y)) + VERTICAL_GAP + 20
    : 300;

  return { nodes, edges: validEdges, yearColumns, dividers, width, height };
}

export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  if (Math.abs(dx) < 10) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }
  const cx = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${cx} ${from.y}, ${cx} ${to.y}, ${to.x} ${to.y}`;
}
