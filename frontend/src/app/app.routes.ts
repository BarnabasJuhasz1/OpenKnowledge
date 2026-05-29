import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/search/search.component').then(m => m.SearchComponent),
  },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
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
        path: 'relevancy',
        loadComponent: () =>
          import('./features/relevancy/relevancy.component').then(m => m.RelevancyComponent),
      },
      {
        path: 'graph',
        loadComponent: () =>
          import('./features/graph/graph.component').then(m => m.GraphComponent),
      },
      {
        path: 'library',
        loadComponent: () =>
          import('./features/library/library.component').then(m => m.LibraryComponent),
      },
      {
        path: 'citgraph',
        loadComponent: () =>
          import('./features/citgraph/citgraph.component').then(m => m.CitGraphComponent),
      },
    ],
  },
  {
    path: 'docs',
    loadComponent: () =>
      import('./features/docs/documentation.component').then(m => m.DocumentationComponent),
  },
  // Backwards-compatible redirects for the old top-level feature paths.
  { path: 'results', redirectTo: 'dashboard/research' },
  { path: 'relevancy', redirectTo: 'dashboard/relevancy' },
  { path: 'graph', redirectTo: 'dashboard/graph' },
  { path: 'library', redirectTo: 'dashboard/library' },
  { path: 'citgraph', redirectTo: 'dashboard/citgraph' },
  { path: '**', redirectTo: '' },
];
