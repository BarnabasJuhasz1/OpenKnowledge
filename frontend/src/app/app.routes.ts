import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
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
  { path: '**', redirectTo: '' },
];
