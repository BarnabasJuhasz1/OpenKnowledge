import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ScoreWeights } from '../../core/models/paper.model';
import { ProjectContextService } from '../../core/services/project-context.service';
import { ProjectScoringService } from '../../core/services/project-scoring.service';
import { DiscoveryTabComponent } from '../relevancy/discovery-tab/discovery-tab.component';

/**
 * Project-scoped settings page. Currently hosts the OK-score configuration that
 * previously lived in the standalone OK-score tab: the weight sliders + live
 * scored-papers table (Discovery), laid out as a single sectioned page.
 * Weights persist per project.
 */
@Component({
  selector: 'app-project-settings',
  standalone: true,
  imports: [FormsModule, DiscoveryTabComponent],
  templateUrl: './project-settings.component.html',
  styleUrl: './project-settings.component.scss',
})
export class ProjectSettingsComponent {
  private readonly projectContext = inject(ProjectContextService);
  private readonly scoringStore = inject(ProjectScoringService);

  readonly activeProject = this.projectContext.activeProject;

  readonly weights = signal<ScoreWeights>(
    this.scoringStore.load(this.projectContext.activeProjectId()),
  );

  onWeightsChange(updated: ScoreWeights): void {
    this.weights.set(updated);
    this.scoringStore.save(this.projectContext.activeProjectId(), updated);
  }
}
