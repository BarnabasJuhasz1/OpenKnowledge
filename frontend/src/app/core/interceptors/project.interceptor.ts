import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ProjectContextService } from '../services/project-context.service';
import { environment } from '../../../environments/environment';

/**
 * Cross-cutting concerns for backend API calls:
 *
 * 1. **Session cookie.** Backend calls go to `environment.BACKEND_URL`, which is
 *    cross-origin from the SPA, so the browser drops the session cookie unless
 *    the request opts in with `withCredentials`. Without it every call looks
 *    unauthenticated and the backend serves the guest (`user_id IS NULL`)
 *    bucket. Set it for all backend API requests so ownership scoping works.
 * 2. **Active project.** Attach the active `project_id` query param to
 *    project-scoped calls so individual services don't each thread it through.
 *    The projects endpoint is exempt (it is the scoping entity itself). Citgraph
 *    builds stay live/project-agnostic, but receive `project_id` so the backend
 *    can enrich nodes with the project's ok-score fields when a project is
 *    active (the param is optional server-side, so demo / no-project builds are
 *    unaffected).
 */
export const projectInterceptor: HttpInterceptorFn = (req, next) => {
  const isApi = req.url.includes(environment.BACKEND_URL + '/api');
  if (!isApi) {
    return next(req);
  }

  // Always carry the session cookie on backend API calls.
  const apiReq = req.withCredentials ? req : req.clone({ withCredentials: true });

  const isExempt = apiReq.url.includes('/api/projects');
  if (isExempt || apiReq.params.has('project_id')) {
    return next(apiReq);
  }

  const projectId = inject(ProjectContextService).activeProjectId();
  if (projectId === null) {
    return next(apiReq);
  }

  return next(
    apiReq.clone({ params: apiReq.params.set('project_id', String(projectId)) })
  );
};
