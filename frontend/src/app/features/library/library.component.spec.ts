import { describe, beforeEach, it, expect, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { LibraryComponent } from './library.component';
import { ShelfService } from '../../core/services/shelf.service';
import { BookshelfService } from '../../core/services/bookshelf.service';
import { NotificationService } from '../../core/services/notification.service';
import { ProjectContextService } from '../../core/services/project-context.service';
import {
  GraphSnapshotService,
  SnapshotError,
  SnapshotMeta,
} from '../../core/services/graph-snapshot.service';

function snap(id: number, name = `snap ${id}`): SnapshotMeta {
  return {
    id, name, seedId: 'n1', nodeCount: 12, clusterCount: 3,
    createdAt: '2026-06-01', updatedAt: '2026-06-02',
  };
}

describe('LibraryComponent — OK-Graph Snapshots tab', () => {
  let fixture: ComponentFixture<LibraryComponent>;
  let comp: LibraryComponent;

  let list: ReturnType<typeof vi.fn>;
  let loadAndApply: ReturnType<typeof vi.fn>;
  let rename: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let show: ReturnType<typeof vi.fn>;

  const activeProjectId = signal<number | null>(42);

  beforeEach(() => {
    activeProjectId.set(42);
    list = vi.fn(() => of([snap(1), snap(2)]));
    loadAndApply = vi.fn(() => of({ ...snap(1), graph: {}, summaries: [] }));
    rename = vi.fn(() => of(snap(1, 'renamed')));
    del = vi.fn(() => of(undefined));
    navigate = vi.fn();
    show = vi.fn();

    TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        { provide: ShelfService, useValue: { list: () => of([]) } },
        { provide: BookshelfService, useValue: { list: () => of([]) } },
        { provide: NotificationService, useValue: { show } },
        { provide: ProjectContextService, useValue: { activeProjectId } },
        {
          provide: GraphSnapshotService,
          useValue: { list, loadAndApply, rename, delete: del },
        },
        { provide: Router, useValue: { navigate } },
      ],
    });
    fixture = TestBed.createComponent(LibraryComponent);
    comp = fixture.componentInstance;
  });

  function rows(): NodeListOf<Element> {
    return fixture.nativeElement.querySelectorAll('.library__item');
  }

  it('switching to the snapshots tab lists the active project snapshots and renders a row each', () => {
    comp.switchTab('snapshots');
    fixture.detectChanges();
    expect(list).toHaveBeenCalledWith(42);
    expect(comp.snapshots().length).toBe(2);
    expect(rows().length).toBe(2);
  });

  it('lists nothing (no request) when there is no active project', () => {
    activeProjectId.set(null);
    comp.switchTab('snapshots');
    expect(list).not.toHaveBeenCalled();
    expect(comp.snapshots()).toEqual([]);
  });

  it('load applies the snapshot and navigates to the project OK-Graph view', () => {
    comp.loadSnapshot(snap(1));
    expect(loadAndApply).toHaveBeenCalledWith(1);
    expect(show).toHaveBeenCalledWith('Loaded "snap 1"');
    expect(navigate).toHaveBeenCalledWith(['/dashboard', 42, 'graph', 'ok']);
  });

  it('a load error toasts and does NOT navigate', () => {
    loadAndApply.mockImplementation(() => throwError(() => new SnapshotError('other', 'boom')));
    comp.loadSnapshot(snap(1));
    expect(show).toHaveBeenCalledWith('boom');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('delete routes through the confirm modal, then deletes and refreshes', () => {
    comp.switchTab('snapshots'); // first list()
    comp.requestDeleteSnapshot(snap(1));
    expect(comp.pendingDelete()?.kind).toBe('snapshot');
    comp.confirmDelete();
    expect(del).toHaveBeenCalledWith(1);
    expect(show).toHaveBeenCalledWith('Snapshot deleted');
    expect(list).toHaveBeenCalledTimes(2); // tab open + post-delete refresh
  });

  it('rename commits a changed name and refreshes', () => {
    comp.switchTab('snapshots');
    comp.startRenameSnapshot(snap(1));
    comp.renameSnapValue.set('renamed');
    comp.saveRenameSnapshot(snap(1));
    expect(rename).toHaveBeenCalledWith(1, 'renamed');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rename is a no-op (no request) when the name is unchanged', () => {
    comp.startRenameSnapshot(snap(1));
    comp.renameSnapValue.set('snap 1');
    comp.saveRenameSnapshot(snap(1));
    expect(rename).not.toHaveBeenCalled();
    expect(comp.renamingSnapId()).toBeNull();
  });
});
