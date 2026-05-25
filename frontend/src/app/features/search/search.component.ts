import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [QueryInputComponent],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent {
  private readonly router = inject(Router);

  onSearch(query: string): void {
    if (!query.trim()) return;
    this.router.navigate(['/results'], { queryParams: { q: query, page: 1 } });
  }
}
