import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ScoreWeights } from '../../core/models/paper.model';
import { ProjectContextService } from '../../core/services/project-context.service';
import { ProjectScoringService } from '../../core/services/project-scoring.service';
import { GraphSettings, ProjectGraphSettingsService } from '../../core/services/project-graph-settings.service';
import { DiscoveryTabComponent } from '../relevancy/discovery-tab/discovery-tab.component';
import { AnalysisTabComponent } from '../relevancy/analysis-tab/analysis-tab.component';

/**
 * Project-scoped settings page. Currently hosts the OK-score configuration that
 * previously lived in the standalone OK-score tab: the weight sliders + live
 * scored-papers table (Discovery) and the single-paper breakdown (Analysis),
 * laid out as a single sectioned page. Weights persist per project.
 */
@Component({
  selector: 'app-project-settings',
  standalone: true,
  imports: [FormsModule, DiscoveryTabComponent, AnalysisTabComponent],
  templateUrl: './project-settings.component.html',
  styleUrl: './project-settings.component.scss',
})
export class ProjectSettingsComponent {
  private readonly projectContext = inject(ProjectContextService);
  private readonly scoringStore = inject(ProjectScoringService);
  private readonly graphStore = inject(ProjectGraphSettingsService);

  readonly activeProject = this.projectContext.activeProject;

  readonly weights = signal<ScoreWeights>(
    this.scoringStore.load(this.projectContext.activeProjectId()),
  );

  /** OK-Graph exploration settings (K-hop depth, per-hop cap, resolution). */
  readonly graphSettings = signal<GraphSettings>(
    this.graphStore.load(this.projectContext.activeProjectId()),
  );

  onWeightsChange(updated: ScoreWeights): void {
    this.weights.set(updated);
    this.scoringStore.save(this.projectContext.activeProjectId(), updated);
  }

  /** Patch one OK-Graph setting and persist the whole set for this project. */
  updateGraphSetting(partial: Partial<GraphSettings>): void {
    const next = { ...this.graphSettings(), ...partial };
    this.graphSettings.set(next);
    this.graphStore.save(this.projectContext.activeProjectId(), next);
  }

  /** Coerce a hops input to a positive integer (default 2). */
  parseHops(value: string): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : 2;
  }

  /** Coerce a per-hop input: blank / non-positive → null (no limit). */
  parseMaxPerHop(value: string): number | null {
    const n = Math.round(Number(value));
    return value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Coerce a resolution input to a positive number (default 0.5). */
  parseResolution(value: string): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0.5;
  }
}
