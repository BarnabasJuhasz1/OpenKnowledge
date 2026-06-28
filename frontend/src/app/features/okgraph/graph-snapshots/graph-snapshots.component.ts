import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { OkGraphStateService } from '../../../core/services/okgraph-state.service';
import { ProjectContextService } from '../../../core/services/project-context.service';
import { NotificationService } from '../../../core/services/notification.service';
import {
  GraphSnapshotService,
  SnapshotError,
  SnapshotMeta,
} from '../../../core/services/graph-snapshot.service';

/** Mirror of the backend cap (app/api/snapshots.py MAX_SNAPSHOTS_PER_PROJECT),
 *  surfaced as "n / 3" and used to disable Save before the server 409s. */
const MAX_SNAPSHOTS = 3;

/**
 * Snapshots dropdown for the OK-Graph header: save the current base graph,
 * list/load/rename/delete saved snapshots, with the 3-cap surfaced. Ownership is
 * transitive through the active project (project-ownership series) — a signed-in
 * user's snapshots live under their project, a guest's under the null bucket — so
 * the only gates here are an active project (everything) and a built graph
 * (Save). Loading hydrates the saved summaries with no re-summarization
 * (GraphSnapshotService.loadAndApply → applySnapshot, subtask 04).
 */
@Component({
  selector: 'app-graph-snapshots',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './graph-snapshots.component.html',
  styleUrl: './graph-snapshots.component.scss',
})
export class GraphSnapshotsComponent {
  private readonly snapshotSvc = inject(GraphSnapshotService);
  private readonly state = inject(OkGraphStateService);
  private readonly projectContext = inject(ProjectContextService);
  private readonly notify = inject(NotificationService);

  readonly MAX = MAX_SNAPSHOTS;

  readonly open = signal(false);
  readonly snapshots = signal<SnapshotMeta[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  /** Snapshot id with a row operation (load/rename/delete) in flight. */
  readonly busyId = signal<number | null>(null);

  readonly newName = signal('');

  // Inline edit / confirm targets (id-scoped so only one row is active at once).
  readonly renameId = signal<number | null>(null);
  readonly renameValue = signal('');
  readonly confirmLoadId = signal<number | null>(null);
  readonly confirmDeleteId = signal<number | null>(null);

  readonly hasGraph = this.state.hasContent;
  readonly hasProject = computed(() => this.projectContext.activeProjectId() !== null);
  readonly atCap = computed(() => this.snapshots().length >= this.MAX);
  readonly canSave = computed(() =>
    this.hasGraph() &&
    this.hasProject() &&
    !this.atCap() &&
    !this.saving() &&
    this.newName().trim().length > 0,
  );

  toggle(): void {
    const next = !this.open();
    this.open.set(next);
    if (next) {
      this.resetTransient();
      this.newName.set(this.defaultName());
      this.refresh();
    }
  }

  close(): void {
    this.open.set(false);
    this.resetTransient();
  }

  private resetTransient(): void {
    this.renameId.set(null);
    this.confirmLoadId.set(null);
    this.confirmDeleteId.set(null);
  }

  /** Suggested name: the seed paper's (trimmed) title, else a dated fallback. */
  private defaultName(): string {
    const raw = this.state.rawGraph();
    const seed = raw?.nodes.find(n => n.paper_id === raw.seedId);
    const title = seed?.title?.trim();
    const date = new Date().toISOString().slice(0, 10);
    if (title) return `${title.slice(0, 40)} — ${date}`;
    return `Snapshot ${date}`;
  }

  refresh(): void {
    const pid = this.projectContext.activeProjectId();
    if (pid === null) {
      this.snapshots.set([]);
      return;
    }
    this.loading.set(true);
    this.snapshotSvc.list(pid).subscribe({
      next: rows => {
        this.snapshots.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.snapshots.set([]);
        this.loading.set(false);
      },
    });
  }

  save(): void {
    if (!this.canSave()) return;
    const pid = this.projectContext.activeProjectId();
    if (pid === null) return;
    const name = this.newName().trim();
    this.saving.set(true);
    this.snapshotSvc.save(pid, name).subscribe({
      next: () => {
        this.saving.set(false);
        this.notify.show(`Snapshot "${name}" saved.`);
        this.newName.set(this.defaultName());
        this.refresh();
      },
      error: err => {
        this.saving.set(false);
        this.notify.show(this.messageFor(err));
      },
    });
  }

  requestLoad(s: SnapshotMeta): void {
    this.resetTransient();
    // A graph is on screen (possibly explored) — confirm before replacing it.
    if (this.hasGraph()) this.confirmLoadId.set(s.id);
    else this.doLoad(s);
  }

  confirmLoad(s: SnapshotMeta): void {
    this.confirmLoadId.set(null);
    this.doLoad(s);
  }

  cancelLoad(): void {
    this.confirmLoadId.set(null);
  }

  private doLoad(s: SnapshotMeta): void {
    this.busyId.set(s.id);
    this.snapshotSvc.loadAndApply(s.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.notify.show(`Loaded "${s.name}".`);
        this.close();
      },
      error: err => {
        this.busyId.set(null);
        this.notify.show(this.messageFor(err));
      },
    });
  }

  startRename(s: SnapshotMeta): void {
    this.resetTransient();
    this.renameId.set(s.id);
    this.renameValue.set(s.name);
  }

  cancelRename(): void {
    this.renameId.set(null);
  }

  commitRename(s: SnapshotMeta): void {
    const name = this.renameValue().trim();
    if (!name || name === s.name) {
      this.renameId.set(null);
      return;
    }
    this.busyId.set(s.id);
    this.snapshotSvc.rename(s.id, name).subscribe({
      next: () => {
        this.busyId.set(null);
        this.renameId.set(null);
        this.notify.show(`Renamed to "${name}".`);
        this.refresh();
      },
      error: err => {
        this.busyId.set(null);
        this.notify.show(this.messageFor(err));
      },
    });
  }

  requestDelete(s: SnapshotMeta): void {
    this.resetTransient();
    this.confirmDeleteId.set(s.id);
  }

  cancelDelete(): void {
    this.confirmDeleteId.set(null);
  }

  confirmDelete(s: SnapshotMeta): void {
    this.confirmDeleteId.set(null);
    this.busyId.set(s.id);
    this.snapshotSvc.delete(s.id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.notify.show('Snapshot deleted.');
        this.refresh();
      },
      error: err => {
        this.busyId.set(null);
        this.notify.show(this.messageFor(err));
      },
    });
  }

  /** User-facing copy for a failed snapshot op; typed kinds get a tailored hint. */
  private messageFor(err: unknown): string {
    if (err instanceof SnapshotError) {
      switch (err.kind) {
        case 'limit':
          return `You can keep up to ${this.MAX} snapshots per project — delete one first.`;
        case 'duplicate-name':
          return 'A snapshot with that name already exists — pick another name.';
        case 'no-graph':
          return 'There is no graph to save yet.';
        case 'no-project':
          return 'Select a project first.';
        default:
          return err.message || 'Snapshot operation failed.';
      }
    }
    return 'Snapshot operation failed.';
  }
}
