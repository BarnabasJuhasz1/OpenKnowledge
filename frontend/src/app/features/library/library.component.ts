import { Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ShelfService, ShelfItem } from '../../core/services/shelf.service';
import { BookshelfService, BookshelfItem } from '../../core/services/bookshelf.service';
import { NotificationService } from '../../core/services/notification.service';

type PendingDelete =
  | { kind: 'query'; item: ShelfItem; name: string }
  | { kind: 'book'; item: BookshelfItem; name: string };

@Component({
  selector: 'app-library',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
})
export class LibraryComponent implements OnInit {
  private readonly shelf = inject(ShelfService);
  private readonly bookshelf = inject(BookshelfService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  activeTab = signal<'shelf' | 'bookshelf'>('shelf');

  // Query Shelf state
  items = signal<ShelfItem[]>([]);
  newQuery = signal('');
  newLabel = signal('');
  editingId = signal<number | null>(null);
  editLabel = signal('');

  // Bookshelf state
  bookshelfItems = signal<BookshelfItem[]>([]);
  editingNotesId = signal<number | null>(null);
  editNotesText = signal('');
  expandedBookId = signal<number | null>(null);

  // Delete confirmation
  pendingDelete = signal<PendingDelete | null>(null);

  ngOnInit(): void {
    this.loadItems();
    this.loadBookshelf();
  }

  switchTab(tab: 'shelf' | 'bookshelf'): void {
    this.activeTab.set(tab);
  }

  // --- Query Shelf ---

  loadItems(): void {
    this.shelf.list().subscribe({
      next: (items) => this.items.set(items),
    });
  }

  addItem(): void {
    const q = this.newQuery().trim();
    if (!q) return;
    const label = this.newLabel().trim() || undefined;
    this.shelf.create(q, label).subscribe({
      next: () => {
        this.newQuery.set('');
        this.newLabel.set('');
        this.loadItems();
        this.notifications.show('Added to shelf');
      },
      error: (err) => {
        if (err?.status === 409) {
          this.notifications.show('This query is already on your shelf');
        } else {
          this.notifications.show('Could not add query');
        }
      },
    });
  }

  useItem(item: ShelfItem): void {
    this.shelf.markUsed(item.id).subscribe();
    this.router.navigate(['/'], {
      queryParams: { q: item.query_text, page: 1 },
    });
  }

  startEdit(item: ShelfItem): void {
    this.editingId.set(item.id);
    this.editLabel.set(item.label || item.query_text);
  }

  saveEdit(item: ShelfItem): void {
    const label = this.editLabel().trim();
    if (!label) return;
    this.shelf.update(item.id, { label }).subscribe({
      next: () => {
        this.editingId.set(null);
        this.loadItems();
      },
    });
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  removeItem(item: ShelfItem): void {
    this.shelf.remove(item.id).subscribe({
      next: () => {
        this.loadItems();
        this.notifications.show('Removed from shelf');
      },
    });
  }

  onAddKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.addItem();
    }
  }

  onEditKeydown(event: KeyboardEvent, item: ShelfItem): void {
    if (event.key === 'Enter') {
      this.saveEdit(item);
    } else if (event.key === 'Escape') {
      this.cancelEdit();
    }
  }

  // --- Bookshelf ---

  loadBookshelf(): void {
    this.bookshelf.list().subscribe({
      next: (items) => this.bookshelfItems.set(items),
    });
  }

  startEditNotes(item: BookshelfItem): void {
    this.editingNotesId.set(item.id);
    this.editNotesText.set(item.notes ?? '');
  }

  saveNotes(item: BookshelfItem): void {
    const notes = this.editNotesText();
    this.bookshelf.updateNotes(item.id, notes).subscribe({
      next: () => {
        this.editingNotesId.set(null);
        this.loadBookshelf();
        this.notifications.show('Notes saved');
      },
    });
  }

  cancelEditNotes(): void {
    this.editingNotesId.set(null);
  }

  removeBookshelfItem(item: BookshelfItem): void {
    this.bookshelf.remove(item.id).subscribe({
      next: () => {
        if (this.expandedBookId() === item.id) this.expandedBookId.set(null);
        this.loadBookshelf();
        this.notifications.show('Removed from bookshelf');
      },
    });
  }

  toggleExpand(item: BookshelfItem): void {
    this.expandedBookId.update((id) => (id === item.id ? null : item.id));
  }

  hasDetails(item: BookshelfItem): boolean {
    const p = item.paper;
    return !!(
      p &&
      (p.abstract ||
        p.journal ||
        p.venue ||
        p.citation_count !== null ||
        p.reference_count !== null ||
        p.has_public_code ||
        p.code_url ||
        p.pdf_url ||
        p.landing_url)
    );
  }

  onNotesKeydown(event: KeyboardEvent, item: BookshelfItem): void {
    if (event.key === 'Escape') {
      this.cancelEditNotes();
    }
  }

  // --- Delete confirmation ---

  requestDeleteQuery(item: ShelfItem): void {
    this.pendingDelete.set({ kind: 'query', item, name: item.label || item.query_text });
  }

  requestDeleteBook(item: BookshelfItem): void {
    this.pendingDelete.set({ kind: 'book', item, name: item.title });
  }

  confirmDelete(): void {
    const pending = this.pendingDelete();
    if (!pending) return;
    if (pending.kind === 'query') {
      this.removeItem(pending.item);
    } else {
      this.removeBookshelfItem(pending.item);
    }
    this.pendingDelete.set(null);
  }

  cancelDelete(): void {
    this.pendingDelete.set(null);
  }
}
