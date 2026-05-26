import { Component, Input, signal } from '@angular/core';
import { Paper } from '../../../core/models/paper.model';

@Component({
  selector: 'app-paper-card',
  standalone: true,
  templateUrl: './paper-card.component.html',
  styleUrl: './paper-card.component.scss',
})
export class PaperCardComponent {
  @Input({ required: true }) paper!: Paper;

  abstractExpanded = signal(false);
  bibtexCopied = signal(false);

  toggleAbstract(): void {
    this.abstractExpanded.update(v => !v);
  }

  async copyBibtex(): Promise<void> {
    if (!this.paper.bibtex) return;
    try {
      await navigator.clipboard.writeText(this.paper.bibtex);
      this.bibtexCopied.set(true);
      setTimeout(() => this.bibtexCopied.set(false), 1500);
    } catch {
      // clipboard not available — silently fail
    }
  }

  openPdf(): void {
    const url = this.paper.pdf_url || this.paper.landing_url;
    if (url) window.open(url, '_blank', 'noopener');
  }

  get authorLine(): string {
    const authors = this.paper.authors;
    if (!authors?.length) return '';
    const names = authors.slice(0, 5).map(a => a.name);
    return authors.length > 5 ? names.join(', ') + ' et al.' : names.join(', ');
  }

  get hasPdf(): boolean {
    return !!(this.paper.pdf_url || this.paper.landing_url);
  }

  get displayYear(): string {
    return this.paper.year ? String(this.paper.year) : '—';
  }

  get sourceLabel(): string {
    return (this.paper.sources ?? [])
      .map(s => s.replace('_', ' '))
      .join(', ');
  }

  get scoreColor(): string {
    const s = this.paper.relevancy_score ?? 0;
    if (s >= 0.7) return '#059669';
    if (s >= 0.4) return '#d97706';
    return '#dc2626';
  }

  get scoreBackground(): string {
    const s = this.paper.relevancy_score ?? 0;
    if (s >= 0.7) return 'rgba(5, 150, 105, 0.1)';
    if (s >= 0.4) return 'rgba(217, 119, 6, 0.1)';
    return 'rgba(220, 38, 38, 0.1)';
  }
}
