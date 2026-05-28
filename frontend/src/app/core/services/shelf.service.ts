import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ShelfItem {
  id: number;
  query_text: string;
  label: string | null;
  created_at: string;
  last_used_at: string;
  use_count: number;
}

@Injectable({ providedIn: 'root' })
export class ShelfService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/shelf';

  list(): Observable<ShelfItem[]> {
    return this.http.get<ShelfItem[]>(this.baseUrl);
  }

  recent(limit = 5): Observable<ShelfItem[]> {
    return this.http.get<ShelfItem[]>(`${this.baseUrl}/recent`, {
      params: { limit: limit.toString() },
    });
  }

  create(queryText: string, label?: string): Observable<ShelfItem> {
    return this.http.post<ShelfItem>(this.baseUrl, {
      query_text: queryText,
      label: label || null,
    });
  }

  update(id: number, data: { query_text?: string; label?: string }): Observable<ShelfItem> {
    return this.http.put<ShelfItem>(`${this.baseUrl}/${id}`, data);
  }

  markUsed(id: number): Observable<ShelfItem> {
    return this.http.put<ShelfItem>(`${this.baseUrl}/${id}/use`, {});
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
