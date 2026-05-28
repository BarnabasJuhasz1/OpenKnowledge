import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ShelfService, ShelfItem } from '../../../core/services/shelf.service';
import { NotificationService } from '../../../core/services/notification.service';

@Component({
  selector: 'app-query-input',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './query-input.component.html',
  styleUrl: './query-input.component.scss',
})
export class QueryInputComponent implements OnChanges {
  @Input() initialQuery = '';
  @Input() loading = false;
  @Input() compact = false;
  @Output() search = new EventEmitter<string>();

  private readonly shelf = inject(ShelfService);
  private readonly notifications = inject(NotificationService);
  private readonly elRef = inject(ElementRef);

  query = signal('');
  shelfOpen = signal(false);
  recentItems = signal<ShelfItem[]>([]);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialQuery']) {
      this.query.set(this.initialQuery);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      this.submit();
    }
    if (event.key === 'Escape') {
      this.shelfOpen.set(false);
    }
  }

  submit(): void {
    const q = this.query().trim();
    if (q && !this.loading) {
      this.search.emit(q);
    }
  }

  toggleShelf(): void {
    if (this.shelfOpen()) {
      this.shelfOpen.set(false);
    } else {
      this.shelf.recent(5).subscribe({
        next: (items) => {
          this.recentItems.set(items);
          this.shelfOpen.set(true);
        },
      });
    }
  }

  pickShelfItem(item: ShelfItem): void {
    this.shelfOpen.set(false);
    this.query.set(item.query_text);
    this.shelf.markUsed(item.id).subscribe();
    this.search.emit(item.query_text);
  }

  saveToShelf(): void {
    const q = this.query().trim();
    if (!q) return;
    this.shelf.create(q).subscribe({
      next: () => this.notifications.show('Saved to shelf'),
      error: (err) =>
        this.notifications.show(
          err?.status === 409 ? 'Query already on your shelf' : 'Could not save query'
        ),
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.shelfOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.shelfOpen.set(false);
    }
  }
}
