import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ProjectService } from '../../../core/services/project.service';
import { ProjectContextService } from '../../../core/services/project-context.service';
import { AuthService } from '../../../core/services/auth.service';

interface FeatureLink {
  path: string;
  label: string;
  icon: string;
}

/**
 * Persistent left navigation rail. Rendered globally (in the app shell) for
 * every signed-in route so it stays visible even on the public landing page.
 * It behaves identically everywhere — the same expand/collapse toggle and
 * persisted collapse state, regardless of which route is showing.
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent implements OnInit {
  private readonly projectService = inject(ProjectService);
  private readonly projectContext = inject(ProjectContextService);
  protected readonly auth = inject(AuthService);

  private static readonly COLLAPSE_KEY = 'ok-sidebar-collapsed';

  readonly projects = this.projectService.projects;
  readonly activeProjectId = this.projectContext.activeProjectId;
  readonly activeProject = this.projectContext.activeProject;

  /** Whether the rail is collapsed to an icons-only rail. Persisted. */
  readonly collapsed = signal<boolean>(this.readCollapsed());

  readonly features: FeatureLink[] = [
    { path: 'search', label: 'Search', icon: 'search' },
    { path: 'research', label: 'Results', icon: 'list_alt' },
    { path: 'graph', label: 'Graph', icon: 'hub' },
    { path: 'library', label: 'Library', icon: 'menu_book' },
    { path: 'project-settings', label: 'Project Settings', icon: 'tune' },
  ];

  ngOnInit(): void {
    // The rail lives outside the dashboard now, so it owns loading the project
    // list (the dashboard may never mount, e.g. while on the landing page).
    if (this.projects().length === 0) {
      this.projectService.load().subscribe({ next: () => {}, error: () => {} });
    }
  }

  /** Display name for the signed-in user chip (first name, or email). */
  displayName(): string {
    const user = this.auth.user();
    if (!user) return '';
    if (user.name) return user.name.split(' ')[0];
    return user.email ?? 'Account';
  }

  /** Route into the active project's feature view. */
  featureLink(path: string): (string | number)[] {
    return ['/dashboard', this.activeProjectId() ?? 0, path];
  }

  /** Toggle the icons-only collapsed state and persist the choice. */
  toggleCollapse(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    try {
      localStorage.setItem(SidebarComponent.COLLAPSE_KEY, String(next));
    } catch {
      // Storage may be unavailable (private mode); collapse still works for the session.
    }
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem(SidebarComponent.COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}
