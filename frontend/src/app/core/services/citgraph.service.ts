import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface CitGraphNode {
  paper_id: string;
  doi: string | null;
  arxiv_id: string | null;
  title: string;
  abstract: string | null;
  year: number | null;
  citation_count: number | null;
  reference_count: number | null;
  authors: string[];
  journal: string | null;
  is_open_access: boolean;
  pdf_url: string | null;
  fields_of_study: string[];
  hop: number;
  predicted_main_archetype?: string | null;
  predicted_second_tier_archetype?: string | null;
}

export interface CitGraphEdge {
  source: string;
  target: string;
}

export interface CitGraphResponse {
  nodes: CitGraphNode[];
  edges: CitGraphEdge[];
  seed_id: string;
}

@Injectable({ providedIn: 'root' })
export class CitGraphService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/citgraph';

  build(paperId: string, k: number, maxPerHop?: number): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/build`, {
      paper_id: paperId,
      k,
      max_per_hop: maxPerHop ?? 20,
    });
  }

  buildDemo(paperId: string, k: number, maxPerHop?: number): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/demo/build`, {
      paper_id: paperId,
      k,
      max_per_hop: maxPerHop ?? 20,
    });
  }
}
