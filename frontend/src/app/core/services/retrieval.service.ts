import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { SearchRequest, SearchResponse, StreamEvent, BackgroundProgress, Paper } from '../models/paper.model';

@Injectable({ providedIn: 'root' })
export class RetrievalService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api';

  search(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/search`, request);
  }

  demoSearch(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/demo/search`, request);
  }

  searchStream(request: SearchRequest): Observable<StreamEvent | { type: 'done'; data: any }> {
    return new Observable<StreamEvent | { type: 'done'; data: any }>(subscriber => {
      const controller = new AbortController();

      fetch(`${this.baseUrl}/retrieval/search/stream`, {
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

  cancelBackground(jobId: string): Observable<{ status: string; job_id: string }> {
    return this.http.delete<{ status: string; job_id: string }>(
      `${this.baseUrl}/retrieval/background/${jobId}`
    );
  }
}
