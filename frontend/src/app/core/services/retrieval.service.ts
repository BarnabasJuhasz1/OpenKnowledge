import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SearchRequest, SearchResponse, StreamEvent, BackgroundProgress, Paper } from '../models/paper.model';
import { ProjectContextService } from './project-context.service';

/** Server-side filters for a paginated Scholar search (applied across all matches). */
export interface ScholarFiltersPayload {
  year_min?: number | null;
  year_max?: number | null;
  citation_min?: number | null;
  citation_max?: number | null;
  open_access_only?: boolean;
  peer_reviewed_only?: boolean;
  code_only?: boolean;
  archetypes?: string[] | null;
}

/** NDJSON events from the Scholar classify stream (ok-score-ordered batches). */
export type ScholarClassifyEvent =
  | { type: 'distribution'; counts: Record<string, number>; classified: number; total: number }
  | { type: 'archetypes'; data: Record<string, [string | null, string | null]> }
  | { type: 'done'; counts: Record<string, number>; classified: number; total: number }
  | { type: 'error'; detail: string };

/** One page of Scholar results plus the exact total match count. */
export interface ScholarPageResponse {
  papers: Paper[];
  total_found: number;
  page: number;
  page_size: number;
  has_more: boolean;
  queries_used: Record<string, string>;
  result_cap: number;
}

@Injectable({ providedIn: 'root' })
export class RetrievalService {
  private readonly http = inject(HttpClient);
  private readonly projectContext = inject(ProjectContextService);
  private readonly baseUrl = `${environment.BACKEND_URL}/api`;

  /** Append the active project id to a raw URL (fetch() bypasses the interceptor). */
  private withProject(url: string): string {
    const id = this.projectContext.activeProjectId();
    if (id === null) return url;
    return `${url}${url.includes('?') ? '&' : '?'}project_id=${id}`;
  }

  /** @deprecated Live mode is deprecated and unreachable from the UI. Use {@link scholarSearchPage}. */
  search(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/search`, request);
  }

  /** @deprecated Demo mode is deprecated and unreachable from the UI. Use {@link scholarSearchPage}. */
  demoSearch(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/demo/search`, request);
  }

  /**
   * @deprecated Buffered Scholar search — superseded by {@link scholarSearchPage} (paginated,
   * non-blocking) + {@link scholarClassifyStream}. This endpoint classifies inline and is no
   * longer called by the app. Kept only for reference.
   */
  scholarSearch(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/scholar/search`, request);
  }

  /**
   * One page of Scholar results: the backend returns the exact total match count and only
   * the requested page (top results by ok-score), sorted + filtered server-side across all
   * matches. The frontend holds just the current page — further pages are fetched on demand.
   */
  scholarSearchPage(
    request: SearchRequest,
    page: number,
    pageSize: number,
    sort: string,
    filters: ScholarFiltersPayload,
  ): Observable<ScholarPageResponse> {
    return this.http.post<ScholarPageResponse>(
      `${this.baseUrl}/retrieval/scholar/search/page`,
      { ...request, page, page_size: pageSize, sort, filters },
    );
  }

  /**
   * Stream the archetype distribution for a Scholar query. The backend pages the whole
   * match set in descending ok-score order, classifies each batch via the remote model,
   * and emits NDJSON lines: a cumulative `distribution`, per-paper `archetypes`, and a
   * terminal `done`. The result page subscribes to this to fill the distribution panel
   * live, batch by batch.
   */
  scholarClassifyStream(
    request: SearchRequest,
    sort: string,
    filters: ScholarFiltersPayload,
  ): Observable<ScholarClassifyEvent> {
    const body = JSON.stringify({ ...request, sort, filters });
    return new Observable<ScholarClassifyEvent>(subscriber => {
      const controller = new AbortController();

      fetch(this.withProject(`${this.baseUrl}/retrieval/scholar/classify/stream`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) {
            subscriber.error(new Error(`HTTP ${response.status}`));
            return;
          }
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const read = (): void => {
            reader.read().then(({ done, value }) => {
              if (done) {
                subscriber.complete();
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                  subscriber.next(JSON.parse(trimmed) as ScholarClassifyEvent);
                } catch {
                  // skip non-JSON lines
                }
              }
              read();
            }).catch(err => {
              if (err.name !== 'AbortError') subscriber.error(err);
            });
          };

          read();
        })
        .catch(err => {
          if (err.name !== 'AbortError') subscriber.error(err);
        });

      return () => controller.abort();
    });
  }

  /**
   * @deprecated Live-mode SSE search stream. Live mode is deprecated and unreachable from the
   * UI; Scholar mode uses {@link scholarSearchPage} + {@link scholarClassifyStream} instead.
   */
  searchStream(
    request: SearchRequest
  ): Observable<
    | StreamEvent
    | { type: 'done'; data: any }
    | { type: 'archetypes'; data: Record<string, [string | null, string | null]> }
  > {
    return new Observable<
      | StreamEvent
      | { type: 'done'; data: any }
      | { type: 'archetypes'; data: Record<string, [string | null, string | null]> }
    >(subscriber => {
      const controller = new AbortController();

      fetch(this.withProject(`${this.baseUrl}/retrieval/search/stream`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) {
            subscriber.error(new Error(`HTTP ${response.status}`));
            return;
          }

          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const read = (): void => {
            reader.read().then(({ done, value }) => {
              if (done) {
                subscriber.complete();
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6);
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if ('source' in parsed && 'papers' in parsed) {
                      subscriber.next(parsed as StreamEvent);
                    } else if ('archetypes' in parsed) {
                      // Post-classification patch: paperKey -> [primary, secondary]
                      subscriber.next({ type: 'archetypes', data: parsed.archetypes });
                    } else if ('total_found' in parsed) {
                      // This is the done payload
                      subscriber.next({ type: 'done', data: parsed });
                    }
                  } catch {
                    // skip non-JSON lines
                  }
                }
              }

              read();
            }).catch(err => {
              if (err.name !== 'AbortError') {
                subscriber.error(err);
              }
            });
          };

          read();
        })
        .catch(err => {
          if (err.name !== 'AbortError') {
            subscriber.error(err);
          }
        });

      return () => controller.abort();
    });
  }

  /**
   * Subscribe to background fetch progress via SSE.
   * Emits BackgroundProgress events as the background job continues paginating.
   * Also emits a final 'papers' event with the accumulated results.
   *
   * @deprecated Background fetch belongs to the deprecated live mode (see {@link searchStream}).
   */
  backgroundProgress(jobId: string): Observable<{ type: 'progress'; data: BackgroundProgress } | { type: 'papers'; data: { papers: Paper[]; total_background: number } }> {
    return new Observable(subscriber => {
      const controller = new AbortController();

      fetch(`${this.baseUrl}/retrieval/background/${jobId}`, {
        signal: controller.signal,
      })
        .then(response => {
          if (!response.ok) {
            subscriber.error(new Error(`HTTP ${response.status}`));
            return;
          }

          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const read = (): void => {
            reader.read().then(({ done, value }) => {
              if (done) {
                subscriber.complete();
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              let currentEventType = 'message';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEventType = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6);
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (currentEventType === 'papers') {
                      subscriber.next({ type: 'papers', data: parsed });
                    } else if (parsed.job_id) {
                      subscriber.next({ type: 'progress', data: parsed as BackgroundProgress });
                      if (parsed.is_complete) {
                        // Don't complete yet — wait for papers event
                      }
                    }
                  } catch {
                    // skip non-JSON
                  }
                  currentEventType = 'message';
                }
              }

              read();
            }).catch(err => {
              if (err.name !== 'AbortError') {
                subscriber.error(err);
              }
            });
          };

          read();
        })
        .catch(err => {
          if (err.name !== 'AbortError') {
            subscriber.error(err);
          }
        });

      return () => controller.abort();
    });
  }

  /** @deprecated Cancels a deprecated live-mode background fetch (see {@link backgroundProgress}). */
  cancelBackground(jobId: string): Observable<{ status: string; job_id: string }> {
    return this.http.delete<{ status: string; job_id: string }>(
      `${this.baseUrl}/retrieval/background/${jobId}`
    );
  }
}
