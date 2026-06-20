import { Component, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import {
  SearchComposerComponent,
  GeneratedKeywords,
} from '../../shared/components/search-composer/search-composer.component';
import { SearchStateService } from '../../core/services/search-state.service';

interface Pt {
  x: number;
  y: number;
}

interface VoronoiCell {
  /** SVG polygon points string. */
  points: string;
  /** Whether to tint this cell with the accent colour. */
  accent: boolean;
}

@Component({
  selector: 'app-search-tab',
  standalone: true,
  imports: [SearchComposerComponent],
  templateUrl: './search-tab.component.html',
  styleUrl: './search-tab.component.scss',
})
export class SearchTabComponent {
  readonly state = inject(SearchStateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Decorative Voronoi tessellation for the backdrop. Computed once from a set
   * of jittered-grid seed points; each cell is the set of points closer to its
   * seed than to any other, found by clipping a large bounding rectangle against
   * the perpendicular bisector to every other seed (Sutherland–Hodgman). This
   * always yields a closed convex polygon. Seeds are deterministic so the mesh
   * is stable across reloads. The SVG viewport clips the border cells, so the
   * tessellation reads as continuing past the edges of the page.
   */
  readonly voronoiCells: VoronoiCell[] = this.buildVoronoi();

  /** AI-generated keywords fill the keyword box for review (no auto-search). */
  onKeywordsGenerated(result: GeneratedKeywords): void {
    this.state.rawQuery.set(result.query);
  }

  /** Submitting a query takes the user to the Results tab, which runs it. */
  onSearch(query: string): void {
    if (!query.trim()) return;
    // Relative nav keeps us inside the current project (/dashboard/:id/...).
    this.router.navigate(['../research'], {
      relativeTo: this.route,
      queryParams: { q: query, page: 1 },
    });
  }

  // ── Voronoi backdrop generation ────────────────────────────────────────────
  private buildVoronoi(): VoronoiCell[] {
    const seeds = this.makeSeeds();
    // Clip bounds extend well past the 1440×900 viewBox so edge cells are big
    // enough to be cropped by the viewport rather than closing inside it.
    const rect: Pt[] = [
      { x: -260, y: -260 },
      { x: 1700, y: -260 },
      { x: 1700, y: 1160 },
      { x: -260, y: 1160 },
    ];

    const cells: VoronoiCell[] = [];
    for (let i = 0; i < seeds.length; i++) {
      let poly = rect;
      for (let j = 0; j < seeds.length && poly.length; j++) {
        if (i !== j) poly = this.clipHalfPlane(poly, seeds[i], seeds[j]);
      }
      if (poly.length >= 3) {
        cells.push({
          points: poly.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
          // ~10% of cells get a faint accent tint, scattered deterministically.
          accent: ((i * 2654435761) >>> 0) % 100 < 10,
        });
      }
    }
    return cells;
  }

  /** Jittered grid of seed points covering an area larger than the viewBox. */
  private makeSeeds(): Pt[] {
    const rand = this.mulberry32(0x6f6b4e21);
    const cols = 9;
    const rows = 6;
    const minX = -200;
    const minY = -200;
    const cellW = (1640 - minX) / cols;
    const cellH = (1100 - minY) / rows;

    const seeds: Pt[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        seeds.push({
          x: minX + (c + 0.5) * cellW + (rand() - 0.5) * cellW * 0.85,
          y: minY + (r + 0.5) * cellH + (rand() - 0.5) * cellH * 0.85,
        });
      }
    }
    return seeds;
  }

  /** Keep the half of `poly` closer to seed `s` than to seed `p`. */
  private clipHalfPlane(poly: Pt[], s: Pt, p: Pt): Pt[] {
    const mx = (s.x + p.x) / 2;
    const my = (s.y + p.y) / 2;
    const nx = p.x - s.x;
    const ny = p.y - s.y;
    // side <= 0 → on seed s's side of the bisector (inside).
    const side = (q: Pt) => nx * (q.x - mx) + ny * (q.y - my);

    const out: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = side(a);
      const db = side(b);
      if (da <= 0) out.push(a);
      if (da <= 0 !== db <= 0) {
        const t = da / (da - db);
        out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
    return out;
  }

  /** Small deterministic PRNG so the mesh is identical on every load. */
  private mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
