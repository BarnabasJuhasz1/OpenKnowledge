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
  activeTab: 'guide' | 'archetypes' = 'guide';

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

  readonly archetypesList = [
    {
      name: 'The Innovator',
      description: 'Introduces a fundamentally novel methodology, theory, or theoretical framework to the field.',
      badgeClass: 'innovator',
      icon: 'emoji_objects',
      subtypes: ['Algorithm/Architecture', 'Theoretical Proof']
    },
    {
      name: 'The Synthesizer',
      description: 'Aggregates, structures, and builds a comprehensive taxonomy out of existing literature (surveys, systematic reviews).',
      badgeClass: 'synthesizer',
      icon: 'summarize'
    },
    {
      name: 'The Combiner',
      description: 'Fuses two or more distinct, existing methodologies into a single hybrid approach.',
      badgeClass: 'combiner',
      icon: 'layers'
    },
    {
      name: 'The Architect',
      description: 'Chains existing methods together into a novel sequential end-to-end processing pipeline.',
      badgeClass: 'architect',
      icon: 'schema'
    },
    {
      name: 'The Translator',
      description: 'Takes a method established in one domain and adapts it to solve a problem in an entirely different domain.',
      badgeClass: 'translator',
      icon: 'transform'
    },
    {
      name: 'The Evaluator',
      description: 'Runs rigorous comparative tests on existing methods under identical conditions to establish benchmarks.',
      badgeClass: 'evaluator',
      icon: 'fact_check',
      subtypes: ['Algorithmic Benchmark']
    },
    {
      name: 'The Analyst',
      description: 'Reverse-engineers, mathematically analyzes, or explains existing phenomena/methods to understand why they work or fail.',
      badgeClass: 'analyst',
      icon: 'analytics'
    },
    {
      name: 'The Resource Creator',
      description: 'Produces foundational artifacts, datasets, or tooling that enable further research by the community.',
      badgeClass: 'resource-creator',
      icon: 'storage',
      subtypes: ['Dataset/Corpus', 'Software/Library']
    }
  ];

  readonly distributionData = [
    {
      name: 'The Innovator',
      count: 498239,
      percentage: 60.21,
      icon: 'emoji_objects',
      color: '#a855f7',
      gradient: 'linear-gradient(90deg, #a855f7, #c084fc)'
    },
    {
      name: 'The Evaluator',
      count: 64470,
      percentage: 7.79,
      icon: 'fact_check',
      color: '#0ea5e9',
      gradient: 'linear-gradient(90deg, #0ea5e9, #38bdf8)'
    },
    {
      name: 'The Combiner',
      count: 58191,
      percentage: 7.03,
      icon: 'layers',
      color: '#f59e0b',
      gradient: 'linear-gradient(90deg, #f59e0b, #fbbf24)'
    },
    {
      name: 'The Analyst',
      count: 56512,
      percentage: 6.83,
      icon: 'analytics',
      color: '#ef4444',
      gradient: 'linear-gradient(90deg, #ef4444, #f87171)'
    },
    {
      name: 'The Synthesizer',
      count: 55210,
      percentage: 6.67,
      icon: 'summarize',
      color: '#3b82f6',
      gradient: 'linear-gradient(90deg, #3b82f6, #60a5fa)'
    },
    {
      name: 'The Translator',
      count: 39423,
      percentage: 4.76,
      icon: 'transform',
      color: '#ec4899',
      gradient: 'linear-gradient(90deg, #ec4899, #f472b6)'
    },
    {
      name: 'The Architect',
      count: 28571,
      percentage: 3.45,
      icon: 'schema',
      color: '#10b981',
      gradient: 'linear-gradient(90deg, #10b981, #34d399)'
    },
    {
      name: 'The Resource Creator',
      count: 26917,
      percentage: 3.25,
      icon: 'storage',
      color: '#4f46e5',
      gradient: 'linear-gradient(90deg, #4f46e5, #818cf8)'
    }
  ];
}
