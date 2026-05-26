import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { ScoringService } from '../../../core/services/scoring.service';
import { ScoreWeights, ScoredPaper } from '../../../core/models/paper.model';

interface SliderConfig {
  key: keyof ScoreWeights;
  label: string;
  color: string;
}

@Component({
  selector: 'app-discovery-tab',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './discovery-tab.component.html',
  styleUrl: './discovery-tab.component.scss',
})
export class DiscoveryTabComponent implements OnInit, OnDestroy {
  @Input({ required: true }) weights!: ScoreWeights;
  @Output() weightsChange = new EventEmitter<ScoreWeights>();

  private readonly scoring = inject(ScoringService);
  private readonly weightChange$ = new Subject<void>();
  private sub: Subscription | null = null;

  localWeights: ScoreWeights = { w_c: 1, w_code: 1, w_peer: 1, w_data: 1, w_stars: 1 };
  papers = signal<ScoredPaper[]>([]);
  loading = signal(false);
  totalScored = signal(0);
  hasSearched = signal(false);

  readonly sliders: SliderConfig[] = [
    { key: 'w_c', label: 'Citations', color: '#3b82f6' },
    { key: 'w_code', label: 'Code', color: '#10b981' },
    { key: 'w_peer', label: 'Peer Review', color: '#8b5cf6' },
    { key: 'w_data', label: 'Dataset', color: '#f59e0b' },
    { key: 'w_stars', label: 'Stars', color: '#eab308' },
  ];

  ngOnInit(): void {
    this.localWeights = { ...this.weights };
    this.sub = this.weightChange$
      .pipe(debounceTime(300))
      .subscribe(() => this.fetchScores());
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  onSliderChange(key: keyof ScoreWeights, event: Event): void {
    const value = parseFloat((event.target as HTMLInputElement).value);
    this.localWeights = { ...this.localWeights, [key]: value };
    this.weightsChange.emit({ ...this.localWeights });
    this.weightChange$.next();
  }

  truncateTitle(title: string): string {
    return title.length > 80 ? title.slice(0, 77) + '…' : title;
  }

  formatAuthors(authors: { name: string }[]): string {
    if (!authors || authors.length === 0) return '—';
    const names = authors.slice(0, 3).map(a => a.name);
    if (authors.length > 3) names.push('et al.');
    return names.join(', ');
  }

  getScoreColor(score: number): string {
    if (score >= 0.7) return '#059669';
    if (score >= 0.4) return '#d97706';
    return '#dc2626';
  }

  getScoreBackground(score: number): string {
    if (score >= 0.7) return 'rgba(5, 150, 105, 0.1)';
    if (score >= 0.4) return 'rgba(217, 119, 6, 0.1)';
    return 'rgba(220, 38, 38, 0.1)';
  }

  private fetchScores(): void {
    this.loading.set(true);
    this.scoring.scorePapers(this.localWeights).subscribe({
      next: (res) => {
        this.papers.set(res.papers);
        this.totalScored.set(res.total_scored);
        this.hasSearched.set(true);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.hasSearched.set(true);
      },
    });
  }
}
