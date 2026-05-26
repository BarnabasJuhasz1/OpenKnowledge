import { Component, Input, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { ScoringService } from '../../../core/services/scoring.service';
import { ScoreWeights, PaperScoreResponse, ScoreBreakdown } from '../../../core/models/paper.model';

interface BreakdownItem {
  key: keyof ScoreBreakdown;
  label: string;
  color: string;
}

@Component({
  selector: 'app-analysis-tab',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './analysis-tab.component.html',
  styleUrl: './analysis-tab.component.scss',
})
export class AnalysisTabComponent {
  @Input({ required: true }) weights!: ScoreWeights;

  private readonly scoring = inject(ScoringService);

  titleInput = '';
  loading = signal(false);
  result = signal<PaperScoreResponse | null>(null);
  error = signal<string | null>(null);

  readonly breakdownItems: BreakdownItem[] = [
    { key: 'citations_contribution', label: 'Citations', color: '#3b82f6' },
    { key: 'code_contribution', label: 'Code', color: '#10b981' },
    { key: 'peer_review_contribution', label: 'Peer Review', color: '#8b5cf6' },
    { key: 'dataset_contribution', label: 'Dataset', color: '#f59e0b' },
    { key: 'stars_contribution', label: 'Stars', color: '#eab308' },
  ];

  analyze(): void {
    const title = this.titleInput.trim();
    if (!title) return;

    this.loading.set(true);
    this.error.set(null);
    this.result.set(null);

    this.scoring.scoreSinglePaper(title, this.weights).subscribe({
      next: (res) => {
        this.result.set(res);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('No matching paper found. Make sure the title is exact.');
        this.loading.set(false);
      },
    });
  }

  getMaxContribution(): number {
    const r = this.result();
    if (!r) return 1;
    const vals = this.breakdownItems.map(b => r.breakdown[b.key]);
    return Math.max(...vals, 0.01);
  }

  getBarWidth(value: number): number {
    return (value / this.getMaxContribution()) * 100;
  }

  getScoreColor(score: number): string {
    if (score >= 0.7) return '#059669';
    if (score >= 0.4) return '#d97706';
    return '#dc2626';
  }

  getScoreBackground(score: number): string {
    if (score >= 0.7) return 'rgba(5, 150, 105, 0.08)';
    if (score >= 0.4) return 'rgba(217, 119, 6, 0.08)';
    return 'rgba(220, 38, 38, 0.08)';
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.analyze();
    }
  }
}
