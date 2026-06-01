import { Routes } from '@angular/router';
import { authGuard, authGuardChild } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/search/search.component').then(m => m.SearchComponent),
  },
  {
    // Persistent dashboard shell — provides the left sidebar (Dashboard /
    // My Projects / active-project features) around every child page.
    path: 'dashboard',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
    // Every feature lives under /dashboard — gate the shell and all children
    // behind authentication. Typing any sub-URL while signed out redirects home.
    canActivate: [authGuard],
    canActivateChild: [authGuardChild],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      // The "Dashboard" tab — an empty landing page for now.
      {
        path: 'home',
        loadComponent: () =>
          import('./features/dashboard-home/dashboard-home.component').then(
            m => m.DashboardHomeComponent
          ),
      },
      // The "My Projects" tab — list / create / select projects.
      {
        path: 'projects',
        loadComponent: () =>
          import('./features/projects/projects-landing.component').then(
            m => m.ProjectsLandingComponent
          ),
      },
      // The "Settings" tab — appearance / theme switching.
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings.component').then(
            m => m.SettingsComponent
          ),
      },
      // Everything inside a project is scoped by the :projectId segment.
      // Componentless: feature pages render in the shell's outlet.
      {
        path: ':projectId',
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'search' },
          {
            path: 'search',
            loadComponent: () =>
              import('./features/search-tab/search-tab.component').then(m => m.SearchTabComponent),
          },
          {
            path: 'research',
            loadComponent: () =>
              import('./features/results/results.component').then(m => m.ResultsComponent),
          },
          {
            path: 'graph',
            loadComponent: () =>
              import('./features/graph-shell/graph-shell.component').then(m => m.GraphShellComponent),
            children: [
              { path: '', pathMatch: 'full', redirectTo: 'ok' },

              {
                path: 'ok',
                loadComponent: () =>
                  import('./features/okgraph/okgraph.component').then(m => m.OkGraphComponent),
              },
              {
                path: 'clustering',
                loadComponent: () =>
                  import('./features/citgraph/citgraph.component').then(m => m.CitGraphComponent),
              },
              { path: 'citgraph', redirectTo: 'clustering' },
            ],
          },
          {
            path: 'library',
            loadComponent: () =>
              import('./features/library/library.component').then(m => m.LibraryComponent),
          },
          {
            path: 'project-settings',
            loadComponent: () =>
              import('./features/project-settings/project-settings.component').then(
                m => m.ProjectSettingsComponent
              ),
          },
        ],
      },
    ],
  },
  {
    path: 'docs',
    loadComponent: () =>
      import('./features/docs/documentation.component').then(m => m.DocumentationComponent),
  },
  // Legacy feature paths can no longer resolve without a project — send the
  // user to the project picker.
  { path: 'results', redirectTo: 'dashboard/projects' },
  { path: 'relevancy', redirectTo: 'dashboard/projects' },
  { path: 'graph', redirectTo: 'dashboard/projects' },
  { path: 'library', redirectTo: 'dashboard/projects' },
  { path: 'citgraph', redirectTo: 'dashboard/projects' },
  { path: 'clustering', redirectTo: 'dashboard/projects' },
  { path: '**', redirectTo: '' },
];
