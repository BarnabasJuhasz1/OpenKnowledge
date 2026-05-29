import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

interface FeatureLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  readonly features: FeatureLink[] = [
    { path: 'search', label: 'Search', icon: 'search' },
    { path: 'research', label: 'Results', icon: 'list_alt' },
    { path: 'relevancy', label: 'OK-score', icon: 'analytics' },
    { path: 'graph', label: 'Graph', icon: 'hub' },
    { path: 'library', label: 'Library', icon: 'menu_book' },
    { path: 'citgraph', label: 'Cit-Graph', icon: 'account_tree' },
  ];
}
