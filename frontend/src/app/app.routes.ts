import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/search/search.component').then(m => m.SearchComponent),
  },
  {
    path: 'results',
    loadComponent: () =>
      import('./features/results/results.component').then(m => m.ResultsComponent),
  },
  { path: '**', redirectTo: '' },
];
