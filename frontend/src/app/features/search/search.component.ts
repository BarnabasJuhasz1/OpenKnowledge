import { Component, inject, signal, AfterViewInit, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { QueryInputComponent } from '../../shared/components/query-input/query-input.component';

const GITHUB_REPO = 'BarnabasJuhasz1/OpenKnowledge';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [QueryInputComponent, RouterLink],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent implements OnInit, AfterViewInit {
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);

  readonly repoUrl = `https://github.com/${GITHUB_REPO}`;
  readonly stars = signal<number | null>(null);

  onSearch(query: string): void {
    if (!query.trim()) return;
    // Features live inside a project — funnel through the project picker,
    // carrying the query so it can be run once a project is chosen.
    this.router.navigate(['/dashboard/projects'], { queryParams: { q: query } });
  }

  startExploring(): void {
    this.router.navigate(['/dashboard/projects']);
  }

  ngOnInit(): void {
    this.http
      .get<{ stargazers_count: number }>(`https://api.github.com/repos/${GITHUB_REPO}`)
      .subscribe({
        next: (repo) => this.stars.set(repo.stargazers_count),
        error: () => this.stars.set(null),
      });
  }

  /** Compact star count display (e.g. 1.2k for 1234). */
  formatStars(count: number): string {
    if (count < 1000) return count.toString();
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }

  ngAfterViewInit(): void {
    // Scroll-reveal via IntersectionObserver
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('revealed');
            }
          });
        },
        { threshold: 0.1 }
      );

      document.querySelectorAll('.reveal-on-scroll').forEach((el) => {
        observer.observe(el);
      });
    }
  }
}
