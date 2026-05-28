import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Paper } from '../models/paper.model';

export interface BookshelfItem {
  id: number;
  paper_identifier: string;
  title: string;
  authors: string[];
  year: number | null;
  notes: string | null;
  paper: Paper | null;
  created_at: string;
  updated_at: string;
}

export interface BookshelfCheck {
  bookmarked: boolean;
  id: number | null;
}

@Injectable({ providedIn: 'root' })
export class BookshelfService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/bookshelf';

  list(): Observable<BookshelfItem[]> {
    return this.http.get<BookshelfItem[]>(this.baseUrl);
  }

  add(data: {
    paper_identifier: string;
    title: string;
    authors: string[];
    year: number | null;
    notes?: string;
    paper?: Paper;
  }): Observable<BookshelfItem> {
    return this.http.post<BookshelfItem>(this.baseUrl, data);
  }

  updateNotes(id: number, notes: string): Observable<BookshelfItem> {
    return this.http.put<BookshelfItem>(`${this.baseUrl}/${id}`, { notes });
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  check(paperIdentifier: string): Observable<BookshelfCheck> {
    return this.http.get<BookshelfCheck>(
      `${this.baseUrl}/check/${encodeURIComponent(paperIdentifier)}`
    );
  }
}
