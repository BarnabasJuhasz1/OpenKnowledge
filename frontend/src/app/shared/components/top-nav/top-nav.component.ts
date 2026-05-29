import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink, RouterLinkActive } from '@angular/router';

const GITHUB_REPO = 'BarnabasJuhasz1/OpenKnowledge';

@Component({
  selector: 'app-top-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './top-nav.component.html',
  styleUrl: './top-nav.component.scss',
})
export class TopNavComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly repoUrl = `https://github.com/${GITHUB_REPO}`;
  readonly stars = signal<number | null>(null);

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
}
