import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ProjectContextService } from '../services/project-context.service';
import { environment } from '../../../environments/environment';

/**
 * Attaches the active `project_id` query param to project-scoped backend calls
 * so individual services don't each have to thread it through. The projects
 * endpoint is exempt (it is the scoping entity itself). Citgraph builds stay
 * live/project-agnostic, but receive `project_id` so the backend can enrich
 * nodes with the project's ok-score fields when a project is active (the param
 * is optional server-side, so demo / no-project builds are unaffected).
 */
export const projectInterceptor: HttpInterceptorFn = (req, next) => {
  const isApi = req.url.includes(environment.BACKEND_URL + '/api');
  const isExempt = req.url.includes('/api/projects');

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
