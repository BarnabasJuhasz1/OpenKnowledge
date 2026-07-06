import { Component, effect, inject, input, signal } from '@angular/core';
import { ContentService } from '../../../core/services/content.service';
import { renderMarkdown } from '../../utils/markdown';

/**
 * Renders a maintainer-editable Markdown document (the "editable text" scheme).
 *
 * Usage: `<app-markdown src="docs/guide" />` — `src` is the content key
 * (path under `public/content/` without `.md`). The raw Markdown is fetched
 * via {@link ContentService}, converted to a safe HTML subset by
 * {@link renderMarkdown}, and bound through `[innerHTML]`. Angular's default
 * sanitizer is left in force; the renderer only emits allowlisted tags, so no
 * `bypassSecurityTrust*` is needed.
 */
@Component({
  selector: 'app-markdown',
  standalone: true,
  template: `
    @if (loading()) {
      <div class="ok-markdown ok-markdown--loading">Loading…</div>
    } @else {
      <div class="ok-markdown" [innerHTML]="html()"></div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .ok-markdown {
        font-family: var(--ok-font-body);
        color: var(--ok-on-surface);
        line-height: 1.65;
      }
      .ok-markdown--loading {
        color: var(--ok-on-surface-variant);
      }
      .ok-markdown :first-child {
        margin-top: 0;
      }
      .ok-markdown :last-child {
        margin-bottom: 0;
      }
      .ok-markdown h1 {
        font-family: var(--ok-font-headline);
        font-size: 1.9rem;
        font-weight: 700;
        margin: 0 0 var(--ok-space-4);
      }
      .ok-markdown h2 {
        font-family: var(--ok-font-headline);
        font-size: 1.35rem;
        font-weight: 700;
        margin: var(--ok-space-8) 0 var(--ok-space-3);
      }
      .ok-markdown h3 {
        font-size: 1.1rem;
        font-weight: 600;
        margin: var(--ok-space-6) 0 var(--ok-space-2);
      }
      .ok-markdown h4 {
        font-size: 1rem;
        font-weight: 600;
        margin: var(--ok-space-4) 0 var(--ok-space-2);
      }
      .ok-markdown p {
        margin: 0 0 var(--ok-space-4);
      }
      .ok-markdown ul,
      .ok-markdown ol {
        margin: 0 0 var(--ok-space-4);
        padding-left: 1.4em;
      }
      .ok-markdown li {
        margin: 0.2em 0;
      }
      .ok-markdown a {
        color: var(--ok-primary);
        text-decoration: none;
      }
      .ok-markdown a:hover {
        text-decoration: underline;
      }
      .ok-markdown code {
        font-family: var(--ok-font-mono, monospace);
        font-size: 0.9em;
        background: var(--ok-hover-overlay);
        border-radius: var(--ok-radius-sm);
        padding: 0.1em 0.4em;
      }
      .ok-markdown pre {
        background: var(--ok-hover-overlay);
        border: 1px solid var(--ok-outline-variant);
        border-radius: var(--ok-radius-md);
        padding: var(--ok-space-4);
        overflow-x: auto;
        margin: 0 0 var(--ok-space-4);
      }
      .ok-markdown pre code {
        background: none;
        padding: 0;
      }
      .ok-markdown blockquote {
        margin: 0 0 var(--ok-space-4);
        padding: var(--ok-space-2) var(--ok-space-4);
        border-left: 3px solid var(--ok-primary);
        color: var(--ok-on-surface-variant);
      }
      .ok-markdown hr {
        border: none;
        border-top: 1px solid var(--ok-outline-variant);
        margin: var(--ok-space-6) 0;
      }
    `,
  ],
})
export class MarkdownComponent {
  private readonly content = inject(ContentService);

  /** Content key — path under public/content/ without the .md extension. */
  readonly src = input.required<string>();

  protected readonly html = signal('');
  protected readonly loading = signal(true);

  constructor() {
    // Re-fetch whenever the key changes.
    effect((onCleanup) => {
      const key = this.src();
      this.loading.set(true);
      const sub = this.content.load(key).subscribe((md) => {
        this.html.set(renderMarkdown(md));
        this.loading.set(false);
      });
      onCleanup(() => sub.unsubscribe());
    });
  }
}
