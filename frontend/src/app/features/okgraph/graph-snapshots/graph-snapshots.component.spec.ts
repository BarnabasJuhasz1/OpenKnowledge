import { describe, beforeEach, it, expect, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { GraphSnapshotsComponent } from './graph-snapshots.component';
import { GraphSnapshotService, SnapshotError, SnapshotMeta } from '../../../core/services/graph-snapshot.service';
import { OkGraphStateService } from '../../../core/services/okgraph-state.service';
import { ProjectContextService } from '../../../core/services/project-context.service';
import { NotificationService } from '../../../core/services/notification.service';

function meta(id: number, name = `snap ${id}`): SnapshotMeta {
  return { id, name, seedId: 'n1', nodeCount: 12, clusterCount: 3, createdAt: '2026-06-01', updatedAt: '2026-06-01' };
}

describe('GraphSnapshotsComponent', () => {
  let fixture: ComponentFixture<GraphSnapshotsComponent>;
  let comp: GraphSnapshotsComponent;

  let list: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;
  let loadAndApply: ReturnType<typeof vi.fn>;
  let rename: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let show: ReturnType<typeof vi.fn>;

  const hasContent = signal(true);
  const activeProjectId = signal<number | null>(42);
  const rawGraph = signal<any>({ nodes: [{ paper_id: 'n1', title: 'Seed Paper' }], seedId: 'n1' });

  beforeEach(() => {
    hasContent.set(true);
    activeProjectId.set(42);
    list = vi.fn(() => of([meta(1), meta(2)]));
    save = vi.fn(() => of(meta(3)));
    loadAndApply = vi.fn(() => of({ ...meta(1), graph: {}, summaries: [] }));
    rename = vi.fn(() => of(meta(1, 'renamed')));
    del = vi.fn(() => of(undefined));
    show = vi.fn();

    TestBed.configureTestingModule({
      imports: [GraphSnapshotsComponent],
      providers: [
        { provide: GraphSnapshotService, useValue: { list, save, loadAndApply, rename, delete: del } },
        { provide: OkGraphStateService, useValue: { hasContent, rawGraph } },
        { provide: ProjectContextService, useValue: { activeProjectId } },
        { provide: NotificationService, useValue: { show } },
      ],
    });
    fixture = TestBed.createComponent(GraphSnapshotsComponent);
    comp = fixture.componentInstance;
  });

  function rows(): NodeListOf<Element> {
    return fixture.nativeElement.querySelectorAll('.snapshots__row');
  }

  it('opening the panel lists the active project snapshots and renders a row per snapshot', () => {
    comp.toggle();
    fixture.detectChanges();
    expect(list).toHaveBeenCalledWith(42);
    expect(comp.snapshots().length).toBe(2);
    expect(rows().length).toBe(2);
  });

  it('save posts the typed name under the active project, then toasts and refreshes', () => {
    comp.toggle();        // first list() call
    comp.newName.set('My snapshot');
    comp.save();
    expect(save).toHaveBeenCalledWith(42, 'My snapshot');
    expect(show).toHaveBeenCalledWith('Snapshot "My snapshot" saved.');
    expect(list).toHaveBeenCalledTimes(2); // open + post-save refresh
  });

  it('disables save with no built graph or no active project', () => {
    comp.newName.set('x');
    hasContent.set(false);
    expect(comp.canSave()).toBe(false);
    comp.save();
    expect(save).not.toHaveBeenCalled();

    hasContent.set(true);
    activeProjectId.set(null);
    expect(comp.canSave()).toBe(false);
    comp.save();
    expect(save).not.toHaveBeenCalled();
  });

  it('reaches the cap at MAX snapshots — save disabled, no request', () => {
    comp.newName.set('x');
    comp.snapshots.set([meta(1), meta(2), meta(3)]);
    expect(comp.atCap()).toBe(true);
    expect(comp.canSave()).toBe(false);
    comp.save();
    expect(save).not.toHaveBeenCalled();
  });

  it('surfaces the cap 409 as a tailored message', () => {
    save.mockImplementation(() => throwError(() => new SnapshotError('limit', 'Snapshot limit reached')));
    comp.newName.set('dup');
    comp.save();
    expect(show).toHaveBeenCalledWith('You can keep up to 3 snapshots per project — delete one first.');
  });

  it('load confirms first when a graph is open, then applies the snapshot', () => {
    comp.toggle();
    comp.requestLoad(meta(1));
    // A graph is on screen → confirm before replacing it (no load yet).
    expect(comp.confirmLoadId()).toBe(1);
    expect(loadAndApply).not.toHaveBeenCalled();

    comp.confirmLoad(meta(1));
    expect(loadAndApply).toHaveBeenCalledWith(1);
    expect(show).toHaveBeenCalledWith('Loaded "snap 1".');
  });

  it('load applies immediately when no graph is open', () => {
    hasContent.set(false);
    comp.requestLoad(meta(1));
    expect(comp.confirmLoadId()).toBeNull();
    expect(loadAndApply).toHaveBeenCalledWith(1);
  });

  it('delete confirms, deletes, then refreshes', () => {
    comp.toggle();
    comp.requestDelete(meta(1));
    expect(comp.confirmDeleteId()).toBe(1);
    comp.confirmDelete(meta(1));
    expect(del).toHaveBeenCalledWith(1);
    expect(show).toHaveBeenCalledWith('Snapshot deleted.');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rename commits a changed name and refreshes', () => {
    comp.toggle();
    comp.startRename(meta(1));
    comp.renameValue.set('renamed');
    comp.commitRename(meta(1));
    expect(rename).toHaveBeenCalledWith(1, 'renamed');
    expect(list).toHaveBeenCalledTimes(2);
  });
});
