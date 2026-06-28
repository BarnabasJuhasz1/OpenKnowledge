import { describe, it, expect } from 'vitest';
import { buildVoronoiCells, VoronoiSite } from './voronoi-cells';

describe('buildVoronoiCells', () => {
  it('returns no cells for fewer than two sites', () => {
    expect(buildVoronoiCells([], 100, 100)).toEqual([]);
    expect(buildVoronoiCells([{ x: 10, y: 10, color: '#f00' }], 100, 100)).toEqual([]);
  });

  it('produces one closed polygon cell per distinct site, coloured by its site', () => {
    const sites: VoronoiSite[] = [
      { x: 25, y: 25, color: '#f00' },
      { x: 75, y: 25, color: '#0f0' },
      { x: 50, y: 75, color: '#00f' },
    ];
    const cells = buildVoronoiCells(sites, 100, 100);
    expect(cells).toHaveLength(3);
    for (const c of cells) {
      expect(c.path.startsWith('M ')).toBe(true);
      expect(c.path.endsWith(' Z')).toBe(true);
    }
    expect(cells.map(c => c.color).sort()).toEqual(['#00f', '#0f0', '#f00']);
  });

  it('de-duplicates exactly-coincident sites (first colour wins)', () => {
    const sites: VoronoiSite[] = [
      { x: 30, y: 30, color: '#f00' },
      { x: 30, y: 30, color: '#0f0' }, // duplicate point — dropped
      { x: 70, y: 70, color: '#00f' },
    ];
    const cells = buildVoronoiCells(sites, 100, 100);
    expect(cells).toHaveLength(2);
    expect(cells.map(c => c.color).sort()).toEqual(['#00f', '#f00']);
  });

  it('clips cells to the canvas box (no coordinate escapes the bounds)', () => {
    const sites: VoronoiSite[] = [
      { x: 20, y: 20, color: '#f00' },
      { x: 80, y: 80, color: '#00f' },
    ];
    const cells = buildVoronoiCells(sites, 100, 100);
    const nums = cells
      .flatMap(c => c.path.replace(/[MLZ]/g, ' ').trim().split(/\s+/))
      .map(Number)
      .filter(n => Number.isFinite(n));
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...nums)).toBeLessThanOrEqual(100);
  });
});
