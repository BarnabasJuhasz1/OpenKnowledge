import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { SearchRequest, SearchResponse, StreamEvent } from '../models/paper.model';

@Injectable({ providedIn: 'root' })
export class RetrievalService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api';

  search(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.baseUrl}/retrieval/search`, request);
  }

  searchStream(request: SearchRequest): Observable<StreamEvent> {
    return new Observable<StreamEvent>(subscriber => {
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
                    const event: StreamEvent = JSON.parse(jsonStr);
                    if ('source' in event && 'papers' in event) {
                      subscriber.next(event);
                    }
                  } catch {
                    // skip non-JSON lines (like the done event summary)
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
}
