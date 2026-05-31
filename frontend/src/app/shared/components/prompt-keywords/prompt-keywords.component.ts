import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KeywordGenService } from '../../../core/services/keyword-gen.service';
import { NotificationService } from '../../../core/services/notification.service';

export interface GeneratedKeywords {
  query: string;
  keywords: string[];
  method: string;
}

@Component({
  selector: 'app-prompt-keywords',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './prompt-keywords.component.html',
  styleUrl: './prompt-keywords.component.scss',
})
export class PromptKeywordsComponent {
  private readonly keywordGen = inject(KeywordGenService);
  private readonly notifications = inject(NotificationService);

  @Output() generated = new EventEmitter<GeneratedKeywords>();

  readonly prompt = signal('');
  readonly loading = signal(false);
  readonly dragging = signal(false);
  readonly bibName = signal<string | null>(null);
  private bibText = '';

  get canGenerate(): boolean {
    return !this.loading() && (this.prompt().trim().length > 0 || !!this.bibName());
  }

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

  generate(): void {
    if (!this.canGenerate) return;
    this.loading.set(true);
    this.keywordGen.generate(this.prompt().trim(), this.bibText || undefined).subscribe({
      next: result => {
        this.loading.set(false);
        this.generated.emit({
          query: result.query,
          keywords: result.keywords,
          method: result.method,
        });
        const via =
          result.method === 'gemma'
            ? `AI (${result.model ?? 'Gemma'})`
            : 'local fallback';
        this.notifications.show(
          `Added ${result.keywords.length} keywords via ${via} — review and search.`
        );
      },
      error: err => {
        this.loading.set(false);
        this.notifications.show(
          err?.status === 422
            ? 'Add a description or a .bib file first.'
            : 'Keyword generation failed.'
        );
      },
    });
  }
}
