import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface DocFeature {
  icon: string;
  title: string;
  body: string;
}

@Component({
  selector: 'app-documentation',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './documentation.component.html',
  styleUrl: './documentation.component.scss',
})
export class DocumentationComponent {
  readonly features: DocFeature[] = [
    {
      icon: 'search',
      title: 'Research',
      body: 'Query OpenAlex, Semantic Scholar, arXiv, PubMed, DBLP, CrossRef, Europe PMC and CORE at once. Results are deduplicated across sources and streamed in as each database responds.',
    },
    {
      icon: 'analytics',
      title: 'OK-score',
      body: 'A composite relevancy score combining citation counts, code availability, peer-review status, data openness and repository stars. Tune the weights to match what matters for your review.',
    },
    {
      icon: 'hub',
      title: 'Graph',
      body: 'Visualize the top results as an interactive citation network laid out by year. Expand a node to pull in the papers it cites or that cite it, and inspect any paper in the detail panel.',
    },
    {
      icon: 'menu_book',
      title: 'Library',
      body: 'Save queries to your shelf and bookmark individual papers to your bookshelf so you can return to a line of inquiry without re-running the search.',
    },
    {
      icon: 'account_tree',
      title: 'Cit-Graph',
      body: 'Build a citation graph from a single seed paper by DOI, Semantic Scholar ID or arXiv ID, with community detection to surface clusters of related work.',
    },
  ];
}
