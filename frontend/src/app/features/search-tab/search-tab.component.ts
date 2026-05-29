import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';
import { SearchStateService } from '../../core/services/search-state.service';
import { DemoModeService } from '../../core/services/demo-mode.service';

@Component({
  selector: 'app-search-tab',
  standalone: true,
  imports: [QueryInputComponent],
  templateUrl: './search-tab.component.html',
  styleUrl: './search-tab.component.scss',
})
export class SearchTabComponent {
  readonly state = inject(SearchStateService);
  readonly demo = inject(DemoModeService);
  private readonly router = inject(Router);

  /** Submitting a query takes the user to the Results tab, which runs it. */
  onSearch(query: string): void {
    if (!query.trim()) return;
    this.router.navigate(['/dashboard/research'], {
      queryParams: { q: query, page: 1 },
    });
  }
}
