import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface KeywordGenResult {
  keywords: string[];
  query: string;
  method: string; // 'gemma' | 'heuristic'
  model: string | null;
}

@Injectable({ providedIn: 'root' })
export class KeywordGenService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.BACKEND_URL}/api/keywords`;

  generate(prompt: string, bibtex?: string): Observable<KeywordGenResult> {
    return this.http.post<KeywordGenResult>(`${this.baseUrl}/generate`, {
      prompt,
      bibtex: bibtex ?? null,
    });
  }
}
