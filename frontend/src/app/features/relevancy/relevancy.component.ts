import { Component, signal } from '@angular/core';
import { ScoreWeights } from '../../core/models/paper.model';
import { DiscoveryTabComponent } from './discovery-tab/discovery-tab.component';
import { AnalysisTabComponent } from './analysis-tab/analysis-tab.component';

@Component({
  selector: 'app-relevancy',
  standalone: true,
  imports: [DiscoveryTabComponent, AnalysisTabComponent],
  templateUrl: './relevancy.component.html',
  styleUrl: './relevancy.component.scss',
})
export class RelevancyComponent {
  activeTab = signal<'discovery' | 'analysis'>('discovery');

  weights = signal<ScoreWeights>({
    w_c: 1.0,
    w_code: 1.0,
    w_peer: 1.0,
    w_data: 1.0,
    w_stars: 1.0,
  });

  onWeightsChange(updated: ScoreWeights): void {
    this.weights.set(updated);
  }

  setTab(tab: 'discovery' | 'analysis'): void {
    this.activeTab.set(tab);
  }
}
