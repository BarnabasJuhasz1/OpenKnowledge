import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { FeedbackService } from '../../../core/services/feedback.service';
import { NotificationService } from '../../../core/services/notification.service';

type FeedbackMode = 'bug' | 'feature';

/**
 * Global feedback launcher: a fixed floating button (present on every route via
 * the app shell) that opens a two-tab modal letting alpha testers file a bug
 * report (→ GitHub Issue) or a feature request (→ GitHub Discussion).
 *
 * Hides itself entirely when the backend reports feedback is not configured.
 */
@Component({
  selector: 'app-feedback-widget',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './feedback-widget.component.html',
  styleUrl: './feedback-widget.component.scss',
})
export class FeedbackWidgetComponent {
  private readonly feedback = inject(FeedbackService);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationService);

  readonly enabled = this.feedback.enabled;

  readonly open = signal(false);
  readonly mode = signal<FeedbackMode>('bug');
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  // Shared fields.
  readonly title = signal('');
  readonly description = signal('');
  readonly contactEmail = signal('');
  // Bug-only.
  readonly steps = signal('');
  readonly severity = signal('Medium');
  // Feature-only.
  readonly motivation = signal('');

  readonly severities = ['Low', 'Medium', 'High', 'Critical'];

  // Character limits, kept in sync with the backend Pydantic models
  // (BugReport / FeatureRequest in app/api/feedback.py).
  readonly limits = {
    title: 100,
    description: 2000,
    steps: 1500,
    motivation: 1500,
    contactEmail: 254,
  };

  readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      this.title().trim().length >= 3 &&
      this.description().trim().length >= 10
  );

  constructor() {
    // Probe availability once so the launcher only appears when usable.
    void this.feedback.loadConfig();
  }

  launch(mode: FeedbackMode = 'bug'): void {
    this.mode.set(mode);
    this.resetForm();
    // Prefill the contact field with the signed-in user's email when known.
    this.contactEmail.set(this.auth.user()?.email ?? '');
    this.open.set(true);
  }

  setMode(mode: FeedbackMode): void {
    this.mode.set(mode);
    this.error.set(null);
  }

  close(): void {
    if (this.submitting()) return;
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.close();
  }

  private resetForm(): void {
    this.title.set('');
    this.description.set('');
    this.steps.set('');
    this.severity.set('Medium');
    this.motivation.set('');
    this.error.set(null);
    this.submitting.set(false);
  }

  private trimmedOrNull(value: string): string | null {
    const v = value.trim();
    return v ? v : null;
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      const contact = this.trimmedOrNull(this.contactEmail());
      const result =
        this.mode() === 'bug'
          ? await this.feedback.submitBug({
              title: this.title().trim(),
              description: this.description().trim(),
              steps: this.trimmedOrNull(this.steps()),
              severity: this.severity(),
              contact_email: contact,
              page_url: window.location.href,
              user_agent: navigator.userAgent,
            })
          : await this.feedback.submitFeature({
              title: this.title().trim(),
              description: this.description().trim(),
              motivation: this.trimmedOrNull(this.motivation()),
              contact_email: contact,
            });

      const noun = this.mode() === 'bug' ? 'Bug report' : 'Feature request';
      this.notifications.show(`${noun} submitted — thank you!`, 5000);
      if (result?.url) window.open(result.url, '_blank', 'noopener');
      this.open.set(false);
    } catch (err: unknown) {
      this.error.set(this.messageFor(err));
    } finally {
      this.submitting.set(false);
    }
  }

  private messageFor(err: unknown): string {
    const e = err as { status?: number; error?: { detail?: string } };
    if (e?.error?.detail) return e.error.detail;
    if (e?.status === 0) return 'Could not reach the server. Check your connection.';
    return 'Something went wrong submitting your feedback. Please try again.';
  }
}
