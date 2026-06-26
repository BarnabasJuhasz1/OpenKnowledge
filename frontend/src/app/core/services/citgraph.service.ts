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
  // S2's per-edge "highly influential citation" flag. Sent by the citgraph API
  // (`/build` + `/explore`); absent on edges reconstructed locally from paper
  // reference lists (the "surrounding graph" path), which read as not influential.
  is_influential?: boolean;
}

export interface CitGraphResponse {
  nodes: CitGraphNode[];
  edges: CitGraphEdge[];
  seed_id: string;
}

/** Metadata constraints enforced on every node during backend BFS expansion.
 *  Only fields available on OpenSearch-hydrated nodes (code/peer-reviewed/archetype
 *  are pre-filtered on seeds client-side instead). */
export interface GraphNodeFilterPayload {
  year_min?: number | null;
  year_max?: number | null;
  citation_min?: number | null;
  citation_max?: number | null;
  open_access_only?: boolean;
  fields?: string[];
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
    // Boolean title+abstract query (AND/OR/NOT/phrases). When set it supersedes
    // `keywords`/`include_non_matching` and gates every expanded node on the backend.
    boolean_query?: string | null;
    // Metadata constraints enforced on every node during expansion.
    node_filter?: GraphNodeFilterPayload | null;
    k?: number;
    max_per_hop?: number | null;
    top_k_per_paper?: (number | null)[] | null;
    // When true, keep only S2 "highly influential" citation edges during
    // expansion (admin toggle; see INFLUENTIAL_CITATIONS_ONLY in
    // admin-graph-config.ts). Honoured by the hosted seed path only.
    influential_only?: boolean;
    // v2 ("direction-pure cones") construction. When true AND direction is
    // 'both', the backend builds the graph as the union of a pure future cone
    // and a pure past cone — no node is reached by a path that mixes citation
    // and reference hops. Omitted/false = v1 (the mixed K-hop neighbourhood).
    directional_split?: boolean;
  }): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/explore`, req);
  }

  exploreDemo(req: {
    paper_ids: string[];
    direction: 'past' | 'future' | 'both';
    include_non_matching: boolean;
    keywords: string[];
    // Boolean title+abstract query (AND/OR/NOT/phrases). When set it supersedes
    // `keywords`/`include_non_matching` and gates every expanded node on the backend.
    boolean_query?: string | null;
    // Metadata constraints enforced on every node during expansion.
    node_filter?: GraphNodeFilterPayload | null;
    k?: number;
    max_per_hop?: number | null;
    top_k_per_paper?: (number | null)[] | null;
    // Accepted for request symmetry; the demo corpus carries no influence flag,
    // so the backend ignores this for demo builds.
    influential_only?: boolean;
    // v2 ("direction-pure cones") construction — see explore() above. Honoured
    // by the demo store too.
    directional_split?: boolean;
  }): Observable<CitGraphResponse> {
    return this.http.post<CitGraphResponse>(`${this.baseUrl}/demo/explore`, req);
  }
}
