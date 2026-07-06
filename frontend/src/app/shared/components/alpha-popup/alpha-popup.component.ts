import { Component, HostListener, input, output } from '@angular/core';
import { MarkdownComponent } from '../markdown/markdown.component';

/**
 * Info pop-up explaining the current "Alpha" release stage. Opened from the
 * Alpha badge in the top nav. Body copy is maintainer-editable via the content
 * scheme (`public/content/popups/alpha.md`), rendered with `<app-markdown>`.
 *
 * Reuses the app's modal pattern: backdrop click + Esc to dismiss.
 */
@Component({
  selector: 'app-alpha-popup',
  standalone: true,
  imports: [MarkdownComponent],
  template: `
    @if (open()) {
      <div class="alpha-overlay" (click)="close()">
        <div
          class="alpha-card"
          role="dialog"
          aria-modal="true"
          aria-label="Alpha release information"
          (click)="$event.stopPropagation()"
        >
          <button class="alpha-card__close" type="button" aria-label="Close" (click)="close()">
            <span class="material-symbols-outlined">close</span>
          </button>
          <app-markdown src="popups/alpha" />
        </div>
      </div>
    }
  `,
  styles: [
    `
      .alpha-overlay {
        position: fixed;
        inset: 0;
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--ok-space-4);
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .alpha-card {
        position: relative;
        width: 100%;
        max-width: 480px;
        max-height: 85vh;
        overflow-y: auto;
        padding: var(--ok-space-8);
        background: var(--ok-glass-bg-floating, var(--ok-bg));
        border: 1px solid var(--ok-glass-border, var(--ok-outline-variant));
        border-radius: var(--ok-radius-xl, var(--ok-radius-lg));
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }
      .alpha-card__close {
        position: absolute;
        top: var(--ok-space-3);
        right: var(--ok-space-3);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--ok-radius-full);
        background: var(--ok-hover-overlay);
        color: var(--ok-on-surface-variant);
        cursor: pointer;
        transition: background var(--ok-transition);
      }
      .alpha-card__close:hover {
        background: var(--ok-hover-overlay-strong, var(--ok-hover-overlay));
        color: var(--ok-on-surface);
      }
    `,
  ],
})
export class AlphaPopupComponent {
  /** Controls visibility — bound from the host (top-nav). */
  readonly open = input(false);
  /** Emitted when the user dismisses the pop-up. */
  readonly closed = output<void>();

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
