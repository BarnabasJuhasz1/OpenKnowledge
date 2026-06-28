import { Delaunay } from 'd3-delaunay';

/** A Voronoi site: a point on the canvas carrying its cluster colour. */
export interface VoronoiSite {
  x: number;
  y: number;
  color: string;
}

/** One clipped Voronoi cell: an SVG polygon path filled with its site's cluster colour. */
export interface VoronoiCell {
  path: string;
  color: string;
}

/**
 * Build clipped Voronoi cells over `sites`, one per (de-duplicated) site, coloured by the
 * site's cluster. Cells are clipped to the `[0,0,width,height]` canvas box, so the whole
 * space tessellates by cluster — same-cluster cells, drawn with no stroke, merge into one
 * contiguous region. Exactly-coincident sites are dropped (Delaunay degenerates on
 * duplicates); the first site at a point keeps its colour. Returns `[]` for < 2 sites.
 */
export function buildVoronoiCells(sites: VoronoiSite[], width: number, height: number): VoronoiCell[] {
  if (sites.length < 2) return [];
  const seen = new Set<string>();
  const uniq: VoronoiSite[] = [];
  for (const s of sites) {
    const key = `${Math.round(s.x)},${Math.round(s.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  if (uniq.length < 2) return [];

  const delaunay = Delaunay.from(uniq, s => s.x, s => s.y);
  const voronoi = delaunay.voronoi([0, 0, Math.max(width, 1), Math.max(height, 1)]);
  const cells: VoronoiCell[] = [];
  for (let i = 0; i < uniq.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly || poly.length < 3) continue;
    let d = `M ${poly[0][0]} ${poly[0][1]}`;
    for (let j = 1; j < poly.length; j++) d += ` L ${poly[j][0]} ${poly[j][1]}`;
    d += ' Z';
    cells.push({ path: d, color: uniq[i].color });
  }
  return cells;
}
