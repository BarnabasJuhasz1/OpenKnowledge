import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface Project {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  description?: string | null;
  color?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.BACKEND_URL}/api/projects`;

  /** The user's projects, kept in sync after mutations. */
  readonly projects = signal<Project[]>([]);

  load(): Observable<Project[]> {
    return this.http
      .get<Project[]>(this.baseUrl)
      .pipe(tap(list => this.projects.set(list)));
  }

  get(id: number): Observable<Project> {
    return this.http.get<Project>(`${this.baseUrl}/${id}`);
  }

  create(input: ProjectInput): Observable<Project> {
    return this.http.post<Project>(this.baseUrl, input).pipe(
      tap(created => this.projects.set([...this.projects(), created]))
    );
  }

  update(id: number, input: Partial<ProjectInput>): Observable<Project> {
    return this.http.put<Project>(`${this.baseUrl}/${id}`, input).pipe(
      tap(updated =>
        this.projects.set(this.projects().map(p => (p.id === id ? updated : p)))
      )
    );
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`).pipe(
      tap(() => this.projects.set(this.projects().filter(p => p.id !== id)))
    );
  }
}
