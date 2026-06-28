import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { signal } from '@angular/core';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService, AuthUser } from './auth.service';
import { ProjectContextService } from './project-context.service';
import { Project, ProjectService } from './project.service';

const PROJECTS_URL = `${environment.BACKEND_URL}/api/projects`;

function project(id: number): Project {
  return {
    id,
    name: `P${id}`,
    description: null,
    color: null,
    created_at: '',
    updated_at: '',
  };
}

describe('ProjectContextService auth-aware reload', () => {
  let httpMock: HttpTestingController;
  let appRef: ApplicationRef;
  let ready: ReturnType<typeof signal<boolean>>;
  let user: ReturnType<typeof signal<AuthUser | null>>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let routerUrl: string;

  beforeEach(() => {
    localStorage.clear();
    ready = signal(false);
    user = signal<AuthUser | null>(null);
    navigateByUrl = vi.fn();
    routerUrl = '/dashboard/home';

    TestBed.configureTestingModule({
      providers: [
        ProjectService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { ready, user } },
        {
          provide: Router,
          useValue: {
            get url() {
              return routerUrl;
            },
            navigateByUrl,
          },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    appRef = TestBed.inject(ApplicationRef);
  });

  afterEach(() => httpMock.verify());

  it('does not load projects until auth is ready', () => {
    TestBed.inject(ProjectContextService);
    appRef.tick(); // run the constructor effect — ready() is still false
    httpMock.expectNone(PROJECTS_URL);
  });

  it('loads the project list once auth resolves', () => {
    TestBed.inject(ProjectContextService);
    ready.set(true);
    appRef.tick();
    httpMock.expectOne(PROJECTS_URL).flush([project(1), project(2)]);
  });

  it('reloads on identity change (login/logout)', () => {
    TestBed.inject(ProjectContextService);
    ready.set(true);
    appRef.tick();
    httpMock.expectOne(PROJECTS_URL).flush([project(1)]);

    user.set({ id: 9, provider: 'github', email: null, name: null, avatar_url: null });
    appRef.tick();
    httpMock.expectOne(PROJECTS_URL).flush([project(3)]);
  });

  it('clears an active project that is absent from the reloaded list', () => {
    const ctx = TestBed.inject(ProjectContextService);
    ctx.setActiveProject(99);
    routerUrl = '/dashboard/99/graph';

    ready.set(true);
    appRef.tick();
    httpMock.expectOne(PROJECTS_URL).flush([project(1), project(2)]); // no 99

    expect(ctx.activeProjectId()).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/dashboard/projects');
  });

  it('keeps an active project that is present in the reloaded list', () => {
    const ctx = TestBed.inject(ProjectContextService);
    ctx.setActiveProject(2);
    routerUrl = '/dashboard/2/graph';

    ready.set(true);
    appRef.tick();
    httpMock.expectOne(PROJECTS_URL).flush([project(1), project(2)]);

    expect(ctx.activeProjectId()).toBe(2);
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
