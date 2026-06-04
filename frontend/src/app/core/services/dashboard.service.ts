import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface DashboardTotals {
  projects: number;
  library_papers: number;
  saved_searches: number;
  retrieved_papers: number;
  searches_run: number;
  papers_added_this_week: number;
}

export interface DashboardProjectStat {
  id: number;
  name: string;
  color: string | null;
  library_papers: number;
  saved_searches: number;
  retrieved_papers: number;
  searches_run: number;
  created_at: string;
  last_activity: string;
}

export type DashboardActivityKind =
  | 'library_add'
  | 'saved_search'
  | 'search_run'
  | 'project_created';

export interface DashboardActivityItem {
  kind: DashboardActivityKind;
  project_id: number;
  project_name: string;
  project_color: string | null;
  title: string;
  timestamp: string;
}

export interface DashboardStats {
  totals: DashboardTotals;
  projects: DashboardProjectStat[];
  recent_activity: DashboardActivityItem[];
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.BACKEND_URL}/api/dashboard`;

  /** Portfolio-level overview across every project (not project-scoped). */
  loadStats(): Observable<DashboardStats> {
    return this.http.get<DashboardStats>(`${this.baseUrl}/stats`);
  }
}
