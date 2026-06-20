import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

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
  // Project ok-score enrichment (present when the node matched a paper in the
  // active project's DB; otherwise neutral defaults). Combined with the project's
  // weights to compute the ok-score — see okScore() in cit-node.ts.
  has_public_code?: boolean | null;
  is_peer_reviewed?: boolean | null;
  has_dataset?: boolean;
  repo_stars?: number;
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
  private readonly baseUrl = `${environment.BACKEND_URL}/api/citgraph`;

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

  explore(req: {
    paper_ids: string[];
    direction: 'past' | 'future' | 'both';
    include_non_matching: boolean;
    keywords: string[];
    k?: number;
    max_per_hop?: number | null;
    top_k_per_paper?: (number | null)[] | null;
  }): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/explore`, req);
  }

  exploreDemo(req: {
    paper_ids: string[];
    direction: 'past' | 'future' | 'both';
    include_non_matching: boolean;
    keywords: string[];
    k?: number;
    max_per_hop?: number | null;
    top_k_per_paper?: (number | null)[] | null;
  }): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/demo/explore`, req);
  }
}
