import { Component, OnInit, inject } from '@angular/core';
import {
  RouterOutlet,
  RouterLink,
  RouterLinkActive,
  ActivatedRoute,
  ActivatedRouteSnapshot,
  Router,
  NavigationEnd,
} from '@angular/router';
import { filter } from 'rxjs';
import { ProjectService } from '../../core/services/project.service';
import { ProjectContextService } from '../../core/services/project-context.service';

interface FeatureLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectService = inject(ProjectService);
  private readonly projectContext = inject(ProjectContextService);

  readonly projects = this.projectService.projects;
  readonly activeProjectId = this.projectContext.activeProjectId;
  readonly activeProject = this.projectContext.activeProject;

  readonly features: FeatureLink[] = [
    { path: 'search', label: 'Search', icon: 'search' },
    { path: 'research', label: 'Results', icon: 'list_alt' },
    { path: 'relevancy', label: 'OK-score', icon: 'analytics' },
    { path: 'graph', label: 'Graph', icon: 'hub' },
    { path: 'library', label: 'Library', icon: 'menu_book' },
  ];

  ngOnInit(): void {
    // Keep the sidebar's project list current.
    if (this.projects().length === 0) {
      this.projectService.load().subscribe({
        next: () => this.validateActiveProject(),
        error: () => {},
      });
    }

    // Pick up the active project from the URL on first load and every
    // subsequent navigation into a :projectId route.
    this.syncActiveProjectFromUrl();
    this.router.events
      .pipe(filter(e => e instanceof NavigationEnd))
      .subscribe(() => this.syncActiveProjectFromUrl());
  }

  private syncActiveProjectFromUrl(): void {
    const id = this.findProjectId(this.route.snapshot);
    // Only update when the URL actually names a project; leave the last active
    // project in place while on the Dashboard / My Projects pages.
    if (id !== null && id !== this.activeProjectId()) {
      this.projectContext.setActiveProject(id);
    }
    this.validateActiveProject();
  }

  private findProjectId(route: ActivatedRouteSnapshot | null): number | null {
    while (route) {
      const raw = route.params['projectId'];
      if (raw !== undefined) {
        const id = Number(raw);
        return Number.isFinite(id) ? id : null;
      }
      route = route.firstChild;
    }
    return null;
  }

  /** Drop the active project if it no longer exists (e.g. it was deleted). */
  private validateActiveProject(): void {
    const id = this.activeProjectId();
    if (id === null || this.projects().length === 0) return;
    if (!this.projects().some(p => p.id === id)) {
      this.projectContext.setActiveProject(null);
    }
  }

  /** Route into the active project's feature view. */
  featureLink(path: string): (string | number)[] {
    return ['/dashboard', this.activeProjectId() ?? 0, path];
  }
}
