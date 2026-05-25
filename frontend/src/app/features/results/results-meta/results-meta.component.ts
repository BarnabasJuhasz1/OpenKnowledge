import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-results-meta',
  standalone: true,
  templateUrl: './results-meta.component.html',
  styleUrl: './results-meta.component.scss',
})
export class ResultsMetaComponent {
  @Input({ required: true }) totalFound = 0;
  @Input({ required: true }) totalRaw = 0;
  @Input({ required: true }) deduplicatesRemoved = 0;
  @Input({ required: true }) activeFilter: string | null = null;
  @Input({ required: true }) sourcesQueried: string[] = [];
  @Input({ required: true }) sourcesFailed: string[] = [];
  @Input({ required: true }) sourceErrors: Record<string, string> = {};

  get sourcesLabel(): string {
    return this.sourcesQueried
      .filter(s => !this.sourcesFailed.includes(s))
      .map(s => s.replace('_', ' '))
      .join(', ');
  }

  get failedLabel(): string {
    return this.sourcesFailed
      .map(s => {
        const reason = this.sourceErrors[s];
        const name = s.replace('_', ' ');
        return reason ? `${name} (${reason})` : name;
      })
      .join(', ');
  }
}
