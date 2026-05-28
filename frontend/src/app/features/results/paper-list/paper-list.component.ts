import { Component, HostListener, Input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Paper, ScoreWeights } from '../../../core/models/paper.model';
import { PaperCardComponent } from '../paper-card/paper-card.component';

const PAGE_SIZE = 10;

interface BreakdownEntry {
  label: string;
  color: string;
  value: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  w_c: 1.0, w_code: 1.0, w_peer: 1.0, w_data: 1.0, w_stars: 1.0,
};

@Component({
  selector: 'app-paper-list',
  standalone: true,
  imports: [PaperCardComponent, DecimalPipe],
  templateUrl: './paper-list.component.html',
  styleUrl: './paper-list.component.scss',
})
export class PaperListComponent {
  @Input({ required: true }) papers: Paper[] = [];
  @Input({ required: true }) page = 1;
  @Input() scoresLoading = false;

  popupPaperTitle = signal<string | null>(null);
  popupBreakdown = signal<BreakdownEntry[]>([]);
  popupTotal = signal(0);
  popupMaxContrib = signal(1);

  get pagePapers(): Paper[] {
    const start = (this.page - 1) * PAGE_SIZE;
    return this.papers.slice(start, start + PAGE_SIZE);
  }

  openBreakdown(paper: Paper, event: MouseEvent): void {
    event.stopPropagation();
    if (this.popupPaperTitle() === paper.title) {
      this.closeBreakdown();
      return;
    }

    const w = DEFAULT_WEIGHTS;
    const citations = paper.citation_count ?? 0;
    const hasCode = paper.has_public_code ? 1 : 0;
    const isPeer = paper.is_peer_reviewed ? 1 : 0;
    const hasData = paper.has_dataset ? 1 : 0;
    const stars = paper.repo_stars ?? 0;

    const entries: BreakdownEntry[] = [
      { label: 'Citations', color: '#3b82f6', value: +(w.w_c * Math.log10(1 + citations)).toFixed(3) },
      { label: 'Code', color: '#10b981', value: +(w.w_code * hasCode).toFixed(3) },
      { label: 'Peer Review', color: '#8b5cf6', value: +(w.w_peer * isPeer).toFixed(3) },
      { label: 'Dataset', color: '#f59e0b', value: +(w.w_data * hasData).toFixed(3) },
      { label: 'Stars', color: '#eab308', value: +(w.w_stars * Math.log10(1 + stars)).toFixed(3) },
    ];

    const maxVal = Math.max(...entries.map(e => e.value), 0.01);

    this.popupPaperTitle.set(paper.title);
    this.popupBreakdown.set(entries);
    this.popupTotal.set(paper.ok_score ?? 0);
    this.popupMaxContrib.set(maxVal);
  }

  closeBreakdown(): void {
    this.popupPaperTitle.set(null);
  }

  barWidth(value: number): number {
    return (value / this.popupMaxContrib()) * 100;
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.popupPaperTitle()) this.closeBreakdown();
  }
}
