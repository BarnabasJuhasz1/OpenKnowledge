import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { ProjectService, Project } from '../../core/services/project.service';
import { NotificationService } from '../../core/services/notification.service';

export const PROJECT_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6',
];

@Component({
  selector: 'app-projects-landing',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './projects-landing.component.html',
  styleUrl: './projects-landing.component.scss',
})
export class ProjectsLandingComponent implements OnInit {
  private readonly projectService = inject(ProjectService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly colors = PROJECT_COLORS;
  readonly projects = this.projectService.projects;
  readonly loading = signal(true);
  readonly hasProjects = computed(() => this.projects().length > 0);

  // Create form state
  readonly showForm = signal(false);
  readonly name = signal('');
  readonly description = signal('');
  readonly color = signal(PROJECT_COLORS[0]);
  readonly saving = signal(false);

  // Delete confirmation
  readonly pendingDelete = signal<Project | null>(null);

  ngOnInit(): void {
    this.projectService.load().subscribe({
      next: () => this.loading.set(false),
      error: () => {
        this.loading.set(false);
        this.notifications.show('Could not load projects. Is the backend running?');
      },
    });
  }

  openForm(): void {
    this.name.set('');
    this.description.set('');
    this.color.set(PROJECT_COLORS[0]);
    this.showForm.set(true);
  }

  cancelForm(): void {
    this.showForm.set(false);
  }

  createProject(): void {
    const name = this.name().trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.projectService
      .create({
        name,
        description: this.description().trim() || null,
        color: this.color(),
      })
      .subscribe({
        next: project => {
          this.saving.set(false);
          this.showForm.set(false);
          this.open(project);
        },
        error: () => {
          this.saving.set(false);
          this.notifications.show('Failed to create project.');
        },
      });
  }

  open(project: Project): void {
    // If a query was carried over from the public landing search, run it in the
    // chosen project; otherwise land on the Search tab.
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q) {
      this.router.navigate(['/dashboard', project.id, 'research'], {
        queryParams: { q, page: 1 },
      });
    } else {
      this.router.navigate(['/dashboard', project.id, 'search']);
    }
  }

  confirmDelete(project: Project, event: Event): void {
    event.stopPropagation();
    this.pendingDelete.set(project);
  }

  cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  deleteProject(): void {
    const project = this.pendingDelete();
    if (!project) return;
    this.projectService.remove(project.id).subscribe({
      next: () => {
        this.pendingDelete.set(null);
        this.notifications.show(`Deleted "${project.name}".`);
      },
      error: () => {
        this.pendingDelete.set(null);
        this.notifications.show('Failed to delete project.');
      },
    });
  }
}
