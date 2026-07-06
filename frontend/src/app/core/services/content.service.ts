import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, shareReplay } from 'rxjs/operators';

/**
 * Loads maintainer-editable Markdown documents that drive the "editable text"
 * scheme. Copy for docs, tutorials, FAQs and info pop-ups lives as `.md` files
 * under `public/content/` (served verbatim at `/content/...`); a content
 * **key** is the path under that folder without the extension, e.g.
 * `docs/guide` → `/content/docs/guide.md`.
 *
 * Each key is fetched once and cached for the app's lifetime (`shareReplay`).
 * A failed fetch resolves to a friendly fallback so a missing/renamed file
 * never blanks the page.
 */
@Injectable({ providedIn: 'root' })
export class ContentService {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, Observable<string>>();

  /** Stream the raw Markdown for a content key. Cached per key. */
  load(key: string): Observable<string> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const stream = this.http
      .get(`/content/${key}.md`, { responseType: 'text' })
      .pipe(
        catchError(() => of(`*Content unavailable.*\n\nCould not load \`${key}\`.`)),
        shareReplay(1)
      );
    this.cache.set(key, stream);
    return stream;
  }
}
