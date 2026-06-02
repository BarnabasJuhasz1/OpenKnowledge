import { describe, beforeEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SearchStateService, ALL_ARCHETYPES } from './search-state.service';
import { Paper } from '../models/paper.model';

describe('SearchStateService', () => {
  let service: SearchStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SearchStateService]
    });
    service = TestBed.inject(SearchStateService);
  });

  it('should initialize selectedArchetypes to all archetypes', () => {
    expect(service.selectedArchetypes().size).toBe(ALL_ARCHETYPES.length);
    for (const arch of ALL_ARCHETYPES) {
      expect(service.selectedArchetypes().has(arch)).toBe(true);
    }
  });

  it('should toggle archetype selections correctly', () => {
    const target = 'The Innovator';
    expect(service.selectedArchetypes().has(target)).toBe(true);

    service.toggleArchetype(target);
    expect(service.selectedArchetypes().has(target)).toBe(false);

    service.toggleArchetype(target);
    expect(service.selectedArchetypes().has(target)).toBe(true);
  });

  it('should enable bulk selection of archetypes', () => {
    service.setAllArchetypes(false);
    expect(service.selectedArchetypes().size).toBe(0);

    service.setAllArchetypes(true);
    expect(service.selectedArchetypes().size).toBe(ALL_ARCHETYPES.length);
  });

  it('should filter papers based on selectedArchetypes', () => {
    const papers: Paper[] = [
      {
        title: 'Paper 1',
        predicted_main_archetype: 'The Innovator',
        predicted_second_tier_archetype: 'The Evaluator',
        doi: '1', arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null, dblp_key: null, core_id: null, abstract: null, year: 2020, publication_date: null, authors: [], journal: null, venue: null, volume: null, issue: null, pages: null, publisher: null, is_open_access: false, pdf_url: null, landing_url: null, citation_count: 0, reference_count: 0, referenced_by: [], references: [], is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false, repo_stars: 0, fields_of_study: [], keywords: [], bibtex: null, sources: ['demo'], versions: null
      },
      {
        title: 'Paper 2',
        predicted_main_archetype: 'The Analyst',
        predicted_second_tier_archetype: 'None',
        doi: '2', arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null, dblp_key: null, core_id: null, abstract: null, year: 2021, publication_date: null, authors: [], journal: null, venue: null, volume: null, issue: null, pages: null, publisher: null, is_open_access: false, pdf_url: null, landing_url: null, citation_count: 0, reference_count: 0, referenced_by: [], references: [], is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false, repo_stars: 0, fields_of_study: [], keywords: [], bibtex: null, sources: ['demo'], versions: null
      },
      {
        title: 'Paper 3',
        predicted_main_archetype: undefined,
        predicted_second_tier_archetype: undefined,
        doi: '3', arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null, dblp_key: null, core_id: null, abstract: null, year: 2022, publication_date: null, authors: [], journal: null, venue: null, volume: null, issue: null, pages: null, publisher: null, is_open_access: false, pdf_url: null, landing_url: null, citation_count: 0, reference_count: 0, referenced_by: [], references: [], is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false, repo_stars: 0, fields_of_study: [], keywords: [], bibtex: null, sources: ['demo'], versions: null
      }
    ];

    service.rawPapersBySource.set({ demo: papers });

    // Initially all archetypes are selected, so all 3 papers should be returned
    expect(service.filteredPapers().length).toBe(3);

    // Disable 'The Innovator' -> Paper 1 has it as main, so Paper 1 should be filtered out.
    // Paper 2 (The Analyst) and Paper 3 (unclassified) should stay.
    service.toggleArchetype('The Innovator');
    let filtered = service.filteredPapers();
    expect(filtered.length).toBe(2);
    expect(filtered.some(p => p.title === 'Paper 1')).toBe(false);
    expect(filtered.some(p => p.title === 'Paper 2')).toBe(true);
    expect(filtered.some(p => p.title === 'Paper 3')).toBe(true);

    // Disable 'The Evaluator' (second-tier archetype for Paper 1).
    // Let's re-enable 'The Innovator' but disable 'The Evaluator' -> Paper 1 has it as second-tier, so it should be filtered out.
    service.toggleArchetype('The Innovator'); // Re-enable Innovator
    service.toggleArchetype('The Evaluator'); // Disable Evaluator
    filtered = service.filteredPapers();
    expect(filtered.length).toBe(2);
    expect(filtered.some(p => p.title === 'Paper 1')).toBe(false);

    // If both 'The Innovator' and 'The Evaluator' are enabled, but 'The Analyst' is disabled:
    // Paper 1 (Innovator/Evaluator) is shown, Paper 2 (Analyst) is hidden, Paper 3 (unclassified) is shown.
    service.toggleArchetype('The Evaluator'); // Re-enable Evaluator (now all enabled)
    service.toggleArchetype('The Analyst'); // Disable Analyst
    filtered = service.filteredPapers();
    expect(filtered.length).toBe(2);
    expect(filtered.some(p => p.title === 'Paper 1')).toBe(true);
    expect(filtered.some(p => p.title === 'Paper 2')).toBe(false);
    expect(filtered.some(p => p.title === 'Paper 3')).toBe(true);
  });
});
