import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  DashboardService,
  DashboardStats,
  DashboardActivityItem,
  DashboardActivityKind,
} from '../../core/services/dashboard.service';
import { ProjectContextService } from '../../core/services/project-context.service';

interface Kpi {
  icon: string;
  label: string;
  value: number;
  accent?: boolean;
}

@Component({
  selector: 'app-dashboard-home',
  standalone: true,
  templateUrl: './dashboard-home.component.html',
  styleUrl: './dashboard-home.component.scss',
})
export class DashboardHomeComponent implements OnInit {
  private readonly dashboard = inject(DashboardService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly error = signal(false);
  readonly stats = signal<DashboardStats | null>(null);

  readonly hasProjects = computed(() => (this.stats()?.projects.length ?? 0) > 0);

  /** Headline KPI cards built from the aggregate totals. */
  readonly kpis = computed<Kpi[]>(() => {
    const t = this.stats()?.totals;
    if (!t) return [];
    return [
      { icon: 'folder', label: 'Projects', value: t.projects },
      { icon: 'menu_book', label: 'Library papers', value: t.library_papers },
      { icon: 'bookmark', label: 'Saved searches', value: t.saved_searches },
      { icon: 'travel_explore', label: 'Searches run', value: t.searches_run },
      {
        icon: 'trending_up',
        label: 'Added this week',
        value: t.papers_added_this_week,
        accent: true,
      },
    ];
  });

  /** Largest library size across projects — used to scale comparison bars. */
  readonly maxLibrary = computed(() => {
    const projects = this.stats()?.projects ?? [];
    return projects.reduce((max, p) => Math.max(max, p.library_papers), 0);
  });

  /** Projects ordered by library size (descending) for the comparison chart. */
  readonly rankedProjects = computed(() =>
    [...(this.stats()?.projects ?? [])].sort(
      (a, b) => b.library_papers - a.library_papers
    )
  );

  readonly activity = computed(() => this.stats()?.recent_activity ?? []);

  ngOnInit(): void {
    this.fetch();
  }

  fetch(): void {
    this.loading.set(true);
    this.error.set(false);
    this.dashboard.loadStats().subscribe({
      next: stats => {
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });
  }

  /** Bar width as a percentage of the busiest project's library. */
  barWidth(value: number): number {
    const max = this.maxLibrary();
    if (max <= 0) return 0;
    return Math.max(2, Math.round((value / max) * 100));
  }

  openProject(id: number): void {
    this.projectContext.setActiveProject(id);
    this.router.navigate(['/dashboard', id, 'search']);
  }

  goToProjects(): void {
    this.router.navigate(['/dashboard', 'projects']);
  }

  iconFor(kind: DashboardActivityKind): string {
    switch (kind) {
      case 'library_add':
        return 'bookmark_added';
      case 'saved_search':
        return 'bookmark';
      case 'search_run':
        return 'search';
      case 'project_created':
        return 'create_new_folder';
    }
  }

  verbFor(kind: DashboardActivityKind): string {
    switch (kind) {
      case 'library_add':
        return 'Added to library';
      case 'saved_search':
        return 'Saved a search';
      case 'search_run':
        return 'Ran a search';
      case 'project_created':
        return 'Created project';
    }
  }

  trackActivity(_: number, item: DashboardActivityItem): string {
    return `${item.kind}-${item.project_id}-${item.timestamp}-${item.title}`;
  }

  /** Compact relative time, e.g. "just now", "3h ago", "2d ago". */
  relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 45) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mon = Math.round(day / 30);
    if (mon < 12) return `${mon}mo ago`;
    return `${Math.round(mon / 12)}y ago`;
  }
}
