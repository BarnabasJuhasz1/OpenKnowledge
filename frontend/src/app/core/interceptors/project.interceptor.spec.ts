import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { projectInterceptor } from './project.interceptor';
import { ProjectContextService } from '../services/project-context.service';

const API = environment.BACKEND_URL + '/api';

describe('projectInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let activeId: number | null;

  beforeEach(() => {
    activeId = null;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([projectInterceptor])),
        provideHttpClientTesting(),
        // Stub so the interceptor doesn't construct the real context service
        // (which would kick off its own /api/projects reload effect).
        { provide: ProjectContextService, useValue: { activeProjectId: () => activeId } },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('sends the session cookie (withCredentials) on backend API calls', () => {
    http.get(`${API}/bookshelf`).subscribe();
    const req = httpMock.expectOne(r => r.url === `${API}/bookshelf`);
    expect(req.request.withCredentials).toBe(true);
    req.flush([]);
  });

  it('leaves non-backend (relative) requests untouched', () => {
    http.get('/api/auth/me').subscribe();
    const req = httpMock.expectOne('/api/auth/me');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
  });

  it('exempts /api/projects from the project_id param but still sends credentials', () => {
    activeId = 5;
    http.get(`${API}/projects`).subscribe();
    const req = httpMock.expectOne(`${API}/projects`);
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.params.has('project_id')).toBe(false);
    req.flush([]);
  });

  it('attaches the active project_id to project-scoped calls', () => {
    activeId = 7;
    http.get(`${API}/bookshelf`).subscribe();
    const req = httpMock.expectOne(r => r.url === `${API}/bookshelf`);
    expect(req.request.params.get('project_id')).toBe('7');
    req.flush([]);
  });

  it('does not attach project_id when no project is active', () => {
    activeId = null;
    http.get(`${API}/bookshelf`).subscribe();
    const req = httpMock.expectOne(`${API}/bookshelf`);
    expect(req.request.params.has('project_id')).toBe(false);
    req.flush([]);
  });
});
