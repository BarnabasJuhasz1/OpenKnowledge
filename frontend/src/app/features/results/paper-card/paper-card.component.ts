import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Paper } from '../../../core/models/paper.model';
import { SearchStateService, paperId } from '../../../core/services/search-state.service';
import { DemoModeService } from '../../../core/services/demo-mode.service';
import { NotificationService } from '../../../core/services/notification.service';
import { BookshelfService } from '../../../core/services/bookshelf.service';

@Component({
  selector: 'app-paper-card',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './paper-card.component.html',
  styleUrl: './paper-card.component.scss',
})
export class PaperCardComponent implements OnInit {
  private readonly state = inject(SearchStateService);
  private readonly demo = inject(DemoModeService);
  private readonly notify = inject(NotificationService);
  private readonly bookshelfSvc = inject(BookshelfService);
  @Input({ required: true }) paper!: Paper;

  abstractExpanded = signal(false);
  bibtexCopied = signal(false);
  bookmarked = signal(false);

  toggleAbstract(): void {
    this.abstractExpanded.update(v => !v);
  }

  async copyBibtex(): Promise<void> {
    if (this.demo.enabled() && !this.paper.bibtex) {
      this.notify.show('BibTeX is not available in demo mode');
      return;
    }
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
    if (this.demo.enabled()) {
      this.notify.show('PDF viewing is not available in demo mode');
      return;
    }
    const url = this.paper.pdf_url || this.paper.landing_url;
    if (url) window.open(url, '_blank', 'noopener');
  }

  get authorLine(): string {
    const authors = this.paper.authors;
    if (!authors?.length) return '';
    const names = authors.slice(0, 5).map(a => a.name);
    return authors.length > 5 ? names.join(', ') + ' et al.' : names.join(', ');
  }

  get isDemo(): boolean {
    return this.demo.enabled();
  }

  get hasPdf(): boolean {
    return !!(this.paper.pdf_url || this.paper.landing_url);
  }

  get hasCode(): boolean {
    return !!(this.paper.has_public_code || this.paper.code_url);
  }

  get bibtexDisabled(): boolean {
    if (this.isDemo) return false;
    return !this.paper.bibtex;
  }

  get pdfDisabled(): boolean {
    if (this.isDemo) return false;
    return !this.hasPdf;
  }

  openCode(): void {
    if (this.demo.enabled()) {
      this.notify.show('Code links are not available in demo mode');
      return;
    }
    if (this.paper.code_url) window.open(this.paper.code_url, '_blank', 'noopener');
  }

  get displayYear(): string {
    return this.paper.year ? String(this.paper.year) : '—';
  }

  get inGraph(): boolean {
    return this.state.isInGraph(this.paper);
  }

  addToGraph(): void {
    this.state.addToGraph(this.paper);
  }

  toggleBookshelf(): void {
    const pid = paperId(this.paper);
    if (this.bookmarked()) {
      this.bookshelfSvc.check(pid).subscribe({
        next: (res) => {
          if (res.id) {
            this.bookshelfSvc.remove(res.id).subscribe({
              next: () => {
                this.bookmarked.set(false);
                this.notify.show('Removed from bookshelf');
              },
            });
          }
        },
      });
    } else {
      this.bookshelfSvc.add({
        paper_identifier: pid,
        title: this.paper.title,
        authors: this.paper.authors.map(a => a.name),
        year: this.paper.year,
        paper: this.paper,
      }).subscribe({
        next: () => {
          this.bookmarked.set(true);
          this.notify.show('Added to bookshelf');
        },
        error: () => {
          this.bookmarked.set(true);
        },
      });
    }
  }

  ngOnInit(): void {
    const pid = paperId(this.paper);
    this.bookshelfSvc.check(pid).subscribe({
      next: (res) => this.bookmarked.set(res.bookmarked),
    });
  }
}
