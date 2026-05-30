import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ProjectContextService } from '../services/project-context.service';

/**
 * Attaches the active `project_id` query param to project-scoped backend calls
 * so individual services don't each have to thread it through. Project and
 * citgraph endpoints are exempt (citgraph builds live, projects are the scoping
 * entity itself).
 */
export const projectInterceptor: HttpInterceptorFn = (req, next) => {
  const isApi = req.url.includes('127.0.0.1:8000/api');
  const isExempt =
    req.url.includes('/api/projects') || req.url.includes('/api/citgraph');

  if (!isApi || isExempt || req.params.has('project_id')) {
    return next(req);
  }

  const projectId = inject(ProjectContextService).activeProjectId();
  if (projectId === null) {
    return next(req);
  }

  return next(
    req.clone({ params: req.params.set('project_id', String(projectId)) })
  );
};
