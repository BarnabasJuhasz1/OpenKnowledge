import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ShelfService, ShelfItem } from '../../../core/services/shelf.service';
import { NotificationService } from '../../../core/services/notification.service';
import { KeywordGenService } from '../../../core/services/keyword-gen.service';

export interface GeneratedKeywords {
  query: string;
  keywords: string[];
  method: string;
}

export type ComposerMode = 'keywords' | 'description' | 'bibtex';

interface ModeTab {
  id: ComposerMode;
  label: string;
}

/**
 * Unified research-input box for the search tab. A single boxed control with
 * three mode tabs — Keywords / Description / BibTeX — that swaps the body input
 * and the primary action button.
 *
 *  - Keywords  → user's own boolean query, button "Search" (emits `search`).
 *  - Description / BibTeX → button "Generate keywords"; on success the boolean
 *    query is filled in and the box flips back to the Keywords tab for review.
 *
 * Replaces the old stacked `app-prompt-keywords` + `app-query-input` pair.
 */
@Component({
  selector: 'app-search-composer',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './search-composer.component.html',
  styleUrl: './search-composer.component.scss',
})
export class SearchComposerComponent implements OnChanges {
  @Input() initialQuery = '';
  @Input() loading = false;
  @Output() search = new EventEmitter<string>();
  @Output() generated = new EventEmitter<GeneratedKeywords>();

  private readonly shelf = inject(ShelfService);
  private readonly notifications = inject(NotificationService);
  private readonly keywordGen = inject(KeywordGenService);
  private readonly elRef = inject(ElementRef);

  readonly tabs: ModeTab[] = [
    { id: 'keywords', label: 'Keywords' },
    { id: 'description', label: 'Describe' },
    { id: 'bibtex', label: 'BibTeX' },
  ];

  readonly mode = signal<ComposerMode>('keywords');

  // Keywords mode
  readonly query = signal('');
  readonly shelfOpen = signal(false);
  readonly recentItems = signal<ShelfItem[]>([]);

  /** Whether the current query already exists among the loaded library items. */
  readonly currentInLibrary = computed(() => {
    const q = this.query().trim();
    if (!q) return false;
    return this.recentItems().some(i => i.query_text.trim() === q);
  });

  // Description mode
  readonly prompt = signal('');

  // BibTeX mode
  readonly dragging = signal(false);
  readonly bibName = signal<string | null>(null);
  private bibText = '';

  // Keyword generation in flight
  readonly generating = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialQuery']) {
      this.query.set(this.initialQuery);
    }
  }

  setMode(next: ComposerMode): void {
    this.mode.set(next);
    this.shelfOpen.set(false);
  }

  /** Whether the primary button can fire in the current mode. */
  get canSubmit(): boolean {
    switch (this.mode()) {
      case 'keywords':
        return !this.loading && this.query().trim().length > 0;
      case 'description':
        return !this.generating() && this.prompt().trim().length > 0;
      case 'bibtex':
        return !this.generating() && !!this.bibName();
    }
  }

  /** Single entry point for the primary button. */
  onPrimary(): void {
    if (this.mode() === 'keywords') this.submit();
    else this.generate();
  }

  // ── Keywords mode ──────────────────────────────────────────────────────────
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
        next: items => {
          this.recentItems.set(items);
          this.shelfOpen.set(true);
        },
      });
    }
  }

  private refreshRecent(): void {
    this.shelf.recent(5).subscribe({ next: items => this.recentItems.set(items) });
  }

  pickShelfItem(item: ShelfItem): void {
    this.shelfOpen.set(false);
    this.query.set(item.query_text);
    this.shelf.markUsed(item.id).subscribe();
  }

  saveToShelf(): void {
    const q = this.query().trim();
    if (!q) return;
    this.shelf.create(q).subscribe({
      next: () => {
        this.notifications.show('Saved to library');
        this.refreshRecent();
      },
      error: err =>
        this.notifications.show(
          err?.status === 409 ? 'Query already in your library' : 'Could not save query'
        ),
    });
  }

  // ── BibTeX mode ────────────────────────────────────────────────────────────
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.readBib(file);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.readBib(file);
    input.value = ''; // allow re-selecting the same file
  }

  private readBib(file: File): void {
    if (!file.name.toLowerCase().endsWith('.bib')) {
      this.notifications.show('Please drop a .bib (BibTeX) file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.bibText = String(reader.result ?? '');
      this.bibName.set(file.name);
    };
    reader.onerror = () => this.notifications.show('Could not read that file.');
    reader.readAsText(file);
  }

  clearBib(): void {
    this.bibText = '';
    this.bibName.set(null);
  }

  // ── Keyword generation (description / bibtex → keywords) ────────────────────
  generate(): void {
    if (!this.canSubmit) return;
    this.generating.set(true);
    this.keywordGen.generate(this.prompt().trim(), this.bibText || undefined).subscribe({
      next: result => {
        this.generating.set(false);
        // Fill the keyword box and flip to the Keywords tab for review.
        this.query.set(result.query);
        this.setMode('keywords');
        this.generated.emit({
          query: result.query,
          keywords: result.keywords,
          method: result.method,
        });
        const via =
          result.method !== 'heuristic' ? `AI (${result.model ?? 'model'})` : 'local fallback';
        this.notifications.show(
          `Added ${result.keywords.length} keywords via ${via} — review and search.`
        );
      },
      error: err => {
        this.generating.set(false);
        this.notifications.show(
          err?.status === 422
            ? 'Add a description or a .bib file first.'
            : 'Keyword generation failed.'
        );
      },
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.shelfOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.shelfOpen.set(false);
    }
  }
}
