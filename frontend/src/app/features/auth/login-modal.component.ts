import { Component, HostListener, computed, inject, input, output } from '@angular/core';
import { AuthService, PROVIDER_LABELS } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';

/**
 * Modal provider chooser. Renders one button per *configured* provider
 * (Google / Microsoft / Apple / GitHub); clicking one kicks off that provider's
 * OAuth redirect. Sign-in is the only way into the app's features.
 */
@Component({
  selector: 'app-login-modal',
  standalone: true,
  templateUrl: './login-modal.component.html',
  styleUrl: './login-modal.component.scss',
})
export class LoginModalComponent {
  private readonly auth = inject(AuthService);
  protected readonly themeSvc = inject(ThemeService);

  /** Controls visibility — bound from the host (top-nav). */
  readonly open = input(false);
  /** Emitted when the user dismisses the modal. */
  readonly closed = output<void>();

  /** Provider ids the backend can actually authenticate against. */
  readonly providers = this.auth.providers;
  readonly labels = PROVIDER_LABELS;

  readonly hasProviders = computed(() => this.providers().length > 0);

  label(provider: string): string {
    return this.labels[provider] ?? provider;
  }

  choose(provider: string): void {
    this.auth.login(provider);
  }

  close(): void {
    this.closed.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) {
      this.close();
    }
  }
}
