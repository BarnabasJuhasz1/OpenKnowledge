import { describe, beforeEach, it, expect } from 'vitest';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SearchStateService, ALL_ARCHETYPES } from './search-state.service';
import { Paper } from '../models/paper.model';

describe('SearchStateService', () => {
  let service: SearchStateService;
  let appRef: ApplicationRef;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SearchStateService]
    });
    service = TestBed.inject(SearchStateService);
    appRef = TestBed.inject(ApplicationRef);
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

  it('re-applies streamed archetypes to a page refetched after classification', () => {
    const bare = (doi: string): Paper => ({
      title: `Paper ${doi}`,
      predicted_main_archetype: undefined,
      predicted_second_tier_archetype: undefined,
      doi, arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null, dblp_key: null, core_id: null, abstract: null, year: 2020, publication_date: null, authors: [], journal: null, venue: null, volume: null, issue: null, pages: null, publisher: null, is_open_access: false, pdf_url: null, landing_url: null, citation_count: 0, reference_count: 0, referenced_by: [], references: [], is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false, repo_stars: 0, fields_of_study: [], keywords: [], bibtex: null, sources: ['semantic_scholar'], versions: null,
    });

    // Classification streamed archetypes for paper "1" (keyed by paperId == doi here).
    service.applyArchetypes({ '1': ['The Innovator', 'The Evaluator'] });

    // The page that originally held paper "1" was discarded (navigated away), then the user
    // navigates back — the backend returns the same paper, but bare (no archetype on it).
    service.rawPapersBySource.set({ semantic_scholar: [bare('1')] });

    const refetched = service.filteredPapers().find(p => p.doi === '1');
    expect(refetched?.predicted_main_archetype).toBe('The Innovator');
    expect(refetched?.predicted_second_tier_archetype).toBe('The Evaluator');

    // And the persisted archetype still drives filtering on the refetched page.
    service.toggleArchetype('The Innovator');
    expect(service.filteredPapers().some(p => p.doi === '1')).toBe(false);
  });

  it('clears persisted archetypes on a new search', () => {
    service.applyArchetypes({ '1': ['The Innovator', null] });
    expect(service.archetypesById()['1']).toEqual(['The Innovator', null]);
    service.resetForNewSearch();
    expect(service.archetypesById()).toEqual({});
  });

  it('should filter papers based on selectedFields (field of study)', () => {
    const base = {
      predicted_main_archetype: undefined, predicted_second_tier_archetype: undefined,
      arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null,
      dblp_key: null, core_id: null, abstract: null, year: 2020, publication_date: null,
      authors: [], journal: null, venue: null, volume: null, issue: null, pages: null,
      publisher: null, is_open_access: false, pdf_url: null, landing_url: null,
      citation_count: 0, reference_count: 0, referenced_by: [], references: [],
      is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false,
      repo_stars: 0, keywords: [], bibtex: null, sources: ['demo'], versions: null,
    };
    const papers: Paper[] = [
      { ...base, title: 'CS paper', doi: '1', fields_of_study: ['Computer Science'] },
      { ...base, title: 'Med paper', doi: '2', fields_of_study: ['Medicine'] },
      { ...base, title: 'No field paper', doi: '3', fields_of_study: [] },
    ];

    service.rawPapersBySource.set({ demo: papers });

    // All fields selected → no filtering.
    expect(service.filteredPapers().length).toBe(3);

    // Drop Medicine → the Medicine paper goes; the field-less paper is never hidden.
    service.toggleField('Medicine');
    const filtered = service.filteredPapers();
    expect(filtered.some(p => p.title === 'CS paper')).toBe(true);
    expect(filtered.some(p => p.title === 'Med paper')).toBe(false);
    expect(filtered.some(p => p.title === 'No field paper')).toBe(true);

    // Reset restores all fields.
    service.resetFilters();
    expect(service.filteredPapers().length).toBe(3);
  });

  it('groups field-less papers under Miscellaneous and filters them by it', () => {
    const base = {
      predicted_main_archetype: undefined, predicted_second_tier_archetype: undefined,
      arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null,
      dblp_key: null, core_id: null, abstract: null, year: 2020, publication_date: null,
      authors: [], journal: null, venue: null, volume: null, issue: null, pages: null,
      publisher: null, is_open_access: false, pdf_url: null, landing_url: null,
      citation_count: 0, reference_count: 0, referenced_by: [], references: [],
      is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false,
      repo_stars: 0, keywords: [], bibtex: null, sources: ['demo'], versions: null,
    };
    const papers: Paper[] = [
      { ...base, title: 'CS paper', doi: '1', fields_of_study: ['Computer Science'] },
      { ...base, title: 'No field paper', doi: '2', fields_of_study: [] },
    ];
    service.rawPapersBySource.set({ demo: papers });

    // Drop Miscellaneous → the field-less paper is hidden; the CS paper stays.
    service.toggleField('Miscellaneous');
    let filtered = service.filteredPapers();
    expect(filtered.some(p => p.title === 'CS paper')).toBe(true);
    expect(filtered.some(p => p.title === 'No field paper')).toBe(false);

    // Select ONLY Miscellaneous → only the field-less paper survives.
    service.setAllFields(false);
    service.toggleField('Miscellaneous');
    filtered = service.filteredPapers();
    expect(filtered.map(p => p.title)).toEqual(['No field paper']);
  });

  it('derives year-range bounds from facets (whole match set), not just loaded papers', () => {
    const base = {
      predicted_main_archetype: undefined, predicted_second_tier_archetype: undefined,
      arxiv_id: null, semantic_scholar_id: null, openalex_id: null, pubmed_id: null,
      dblp_key: null, core_id: null, abstract: null, publication_date: null,
      authors: [], journal: null, venue: null, volume: null, issue: null, pages: null,
      publisher: null, is_open_access: false, pdf_url: null, landing_url: null,
      citation_count: 0, reference_count: 0, referenced_by: [], references: [],
      is_peer_reviewed: false, has_public_code: false, code_url: null, has_dataset: false,
      repo_stars: 0, fields_of_study: [], keywords: [], bibtex: null, sources: ['demo'], versions: null,
    };
    // Loaded page spans only 2018–2020; the full match set (per facets) spans 1995–2025.
    service.rawPapersBySource.set({
      demo: [
        { ...base, title: 'A', doi: '1', year: 2018 },
        { ...base, title: 'B', doi: '2', year: 2020 },
      ],
    });
    service.fieldFacets.set({ fields: {}, miscellaneous: 0, total: 2, year_min: 1995, year_max: 2025 });
    appRef.tick(); // flush the sticky-range effects

    // Slider bounds reflect the whole match set, not the loaded 2018–2020 window.
    expect(service.yearRange()).toEqual({ min: 1995, max: 2025 });

    // A narrowing refetch reports a smaller span; sticky bounds must NOT shrink.
    service.fieldFacets.set({ fields: {}, miscellaneous: 0, total: 1, year_min: 2010, year_max: 2012 });
    appRef.tick();
    expect(service.yearRange()).toEqual({ min: 1995, max: 2025 });
  });
});
