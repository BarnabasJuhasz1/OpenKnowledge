import { Component, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';
import {
  PromptKeywordsComponent,
  GeneratedKeywords,
} from '../../shared/components/prompt-keywords/prompt-keywords.component';
import { SearchStateService } from '../../core/services/search-state.service';
import { DemoModeService } from '../../core/services/demo-mode.service';

@Component({
  selector: 'app-search-tab',
  standalone: true,
  imports: [QueryInputComponent, PromptKeywordsComponent],
  templateUrl: './search-tab.component.html',
  styleUrl: './search-tab.component.scss',
})
export class SearchTabComponent {
  readonly state = inject(SearchStateService);
  readonly demo = inject(DemoModeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** AI-generated keywords fill the keyword box for review (no auto-search). */
  onKeywordsGenerated(result: GeneratedKeywords): void {
    this.state.rawQuery.set(result.query);
  }

  /** Submitting a query takes the user to the Results tab, which runs it. */
  onSearch(query: string): void {
    if (!query.trim()) return;
    // Relative nav keeps us inside the current project (/dashboard/:id/...).
    this.router.navigate(['../research'], {
      relativeTo: this.route,
      queryParams: { q: query, page: 1 },
    });
  }
}
