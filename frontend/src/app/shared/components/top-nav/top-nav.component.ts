import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { LoginModalComponent } from '../../../features/auth/login-modal.component';
import { ThemeService } from '../../../core/services/theme.service';

const GITHUB_REPO = 'BarnabasJuhasz1/OpenKnowledge';

@Component({
  selector: 'app-top-nav',
  standalone: true,
  imports: [RouterLink, LoginModalComponent],
  templateUrl: './top-nav.component.html',
  styleUrl: './top-nav.component.scss',
})
export class TopNavComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly themeSvc = inject(ThemeService);

  readonly repoUrl = `https://github.com/${GITHUB_REPO}`;
  readonly stars = signal<number | null>(null);
  readonly loginOpen = signal(false);

  ngOnInit(): void {
    this.http
      .get<{ stargazers_count: number }>(`/api/github/stars/${GITHUB_REPO}`)
      .subscribe({
        next: (repo) => this.stars.set(repo.stargazers_count),
        error: () => this.stars.set(null),
      });

    // A guard redirect carries ?login=required — pop the chooser automatically.
    this.syncLoginParam(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.syncLoginParam(e.urlAfterRedirects));
  }

  private syncLoginParam(url: string): void {
    const wantsLogin = this.router.parseUrl(url).queryParams['login'] != null;
    if (wantsLogin && !this.auth.isAuthenticated()) {
      this.loginOpen.set(true);
    }
  }

  openLogin(): void {
    this.loginOpen.set(true);
  }

  closeLogin(): void {
    this.loginOpen.set(false);
  }

  logout(): void {
    this.auth.logout();
  }

  /** First name (or email) for the compact signed-in chip. */
  displayName(): string {
    const user = this.auth.user();
    if (!user) return '';
    if (user.name) return user.name.split(' ')[0];
    return user.email ?? 'Account';
  }

  /** Compact star count display (e.g. 1.2k for 1234). */
  formatStars(count: number): string {
    if (count < 1000) return count.toString();
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
}
