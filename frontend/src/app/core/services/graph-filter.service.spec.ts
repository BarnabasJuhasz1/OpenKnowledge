import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GraphFilterService,
  NodeLike,
  mergeYearIntervals,
  seedContextIntervals,
  yearInIntervals,
} from './graph-filter.service';
import { ALL_ARCHETYPES, ALL_SELECTABLE_FIELDS, SearchStateService } from './search-state.service';

describe('GraphFilterService', () => {
  let svc: GraphFilterService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(GraphFilterService);
  });

  it('defaults to a no-op filter', () => {
    expect(svc.keywordFilterActive()).toBe(false);
    expect(svc.metadataFilterActive()).toBe(false);
    expect(svc.hasActiveMetadataFilter()).toBe(false);
    expect(svc.metadata().archetypes.size).toBe(ALL_ARCHETYPES.length);
    expect(svc.metadata().fields.size).toBe(ALL_SELECTABLE_FIELDS.length);
    // No active filters ⇒ predicate keeps everything.
    const keep = svc.nodePredicate(true);
    expect(keep({ title: 'anything' })).toBe(true);
  });

  describe('one-directional mirror from Retrieved-Results filters', () => {
    let search: SearchStateService;
    let appRef: ApplicationRef;

    beforeEach(() => {
      search = TestBed.inject(SearchStateService);
      appRef = TestBed.inject(ApplicationRef);
    });

    it('reflects Results filter changes in the graph metadata', () => {
      search.updateFilter({ yearMin: 2018, citationMin: 25, openAccessOnly: true });
      search.setAllArchetypes(false);
      search.toggleArchetype('The Innovator');
      search.setAllFields(false);
      search.toggleField('Computer Science');
      appRef.tick(); // flush the mirror effect

      const m = svc.metadata();
      expect(m.yearMin).toBe(2018);
      expect(m.citationMin).toBe(25);
      expect(m.openAccessOnly).toBe(true);
      expect([...m.archetypes]).toEqual(['The Innovator']);
      expect([...m.fields]).toEqual(['Computer Science']);
    });

    it('uses independent Set instances (no shared mutable reference)', () => {
      appRef.tick();
      expect(svc.metadata().archetypes).not.toBe(search.selectedArchetypes());
      expect(svc.metadata().fields).not.toBe(search.selectedFields());
    });

    it('does NOT propagate graph-panel edits back to Results (one-directional)', () => {
      appRef.tick();
      // Edit the graph metadata directly (what the popup does).
      svc.setAllArchetypes(false);
      svc.updateMetadata({ citationMin: 99 });
      appRef.tick();

      // Results state is untouched.
      expect(search.filters().citationMin).toBeNull();
      expect(search.selectedArchetypes().size).toBe(ALL_ARCHETYPES.length);
    });

    it('holds graph-panel edits against later Results changes (sticky)', () => {
      appRef.tick();
      svc.updateMetadata({ citationMin: 99 }); // user edits the panel → sticky
      appRef.tick();

      // A later Results-filter change must NOT overwrite the sticky graph metadata.
      search.updateFilter({ citationMin: 5, yearMin: 2010 });
      appRef.tick();
      expect(svc.metadata().citationMin).toBe(99);
      expect(svc.metadata().yearMin).toBeNull(); // whole object is held, not just the edited field
    });

    it('Reset discards sticky edits and re-arms the mirror', () => {
      search.updateFilter({ citationMin: 5 });
      appRef.tick();
      svc.updateMetadata({ citationMin: 99 }); // sticky edit
      appRef.tick();
      expect(svc.metadata().citationMin).toBe(99);

      svc.resetMetadata();
      expect(svc.metadata().citationMin).toBe(5); // re-synced to current Results

      // Mirror is live again: a subsequent Results change flows through.
      search.updateFilter({ citationMin: 7 });
      appRef.tick();
      expect(svc.metadata().citationMin).toBe(7);
    });
  });

  it('hasActiveMetadataFilter flips when a constraint changes', () => {
    svc.updateMetadata({ citationMin: 10 });
    expect(svc.hasActiveMetadataFilter()).toBe(true);
    svc.resetMetadata();
    expect(svc.hasActiveMetadataFilter()).toBe(false);
  });

  it('prefill respects userEdited', () => {
    svc.prefillBooleanQuery('machine learning');
    expect(svc.booleanQuery()).toBe('machine learning');
    svc.setBooleanQuery('custom query');
    svc.prefillBooleanQuery('something else'); // ignored after a user edit
    expect(svc.booleanQuery()).toBe('custom query');
    svc.resetAll();
    svc.prefillBooleanQuery('fresh'); // resetAll cleared userEdited
    expect(svc.booleanQuery()).toBe('fresh');
  });

  it('metadataSummary describes active constraints', () => {
    svc.metadataFilterActive.set(true);
    svc.updateMetadata({ citationMin: 5, openAccessOnly: true });
    const summary = svc.metadataSummary();
    expect(summary).toContain('citations');
    expect(summary).toContain('open access');
  });

  describe('backend payloads', () => {
    it('backendBooleanQuery null unless keyword filtering active + non-empty', () => {
      svc.setBooleanQuery('transformer');
      expect(svc.backendBooleanQuery()).toBeNull();
      svc.keywordFilterActive.set(true);
      expect(svc.backendBooleanQuery()).toBe('transformer');
      svc.setBooleanQuery('   ');
      expect(svc.backendBooleanQuery()).toBeNull();
    });

    it('backendNodeFilter null when metadata filter inactive or no enforceable constraint', () => {
      svc.updateMetadata({ citationMin: 10 });
      expect(svc.backendNodeFilter()).toBeNull(); // metadataFilterActive still false
      svc.metadataFilterActive.set(true);
      expect(svc.backendNodeFilter()).toEqual({
        year_min: null, year_max: null, year_intervals: null,
        citation_min: 10, citation_max: null,
        open_access_only: false, fields: [],
      });
      svc.resetMetadata();
      expect(svc.backendNodeFilter()).toBeNull(); // no enforceable constraint
    });

    it('backendNodeFilter includes selected fields only when a subset is chosen', () => {
      svc.metadataFilterActive.set(true);
      svc.setAllFields(false);
      svc.toggleField('Computer Science');
      expect(svc.backendNodeFilter()?.fields).toEqual(['Computer Science']);
    });

    it('backendNodeFilter omits code/peer-reviewed/archetype (not enforceable on expansion)', () => {
      svc.metadataFilterActive.set(true);
      svc.updateMetadata({ codeOnly: true, peerReviewedOnly: true });
      svc.setAllArchetypes(false);
      // Only code/peer/archetype set ⇒ nothing enforceable on the backend ⇒ null.
      expect(svc.backendNodeFilter()).toBeNull();
    });
  });

  describe('nodePredicate — keyword (boolean query)', () => {
    it('applies boolean query only when keyword filtering is active', () => {
      svc.setBooleanQuery('"large language model" AND compression');
      // inactive ⇒ everything passes
      expect(svc.nodePredicate(true)({ title: 'unrelated' })).toBe(true);
      svc.keywordFilterActive.set(true);
      const keep = svc.nodePredicate(true);
      expect(keep({ title: 'Large Language Model compression study' })).toBe(true);
      expect(keep({ title: 'unrelated' })).toBe(false);
    });
  });

  describe('nodePredicate — metadata', () => {
    const node = (over: Partial<NodeLike>): NodeLike => ({
      title: 't', abstract: 'a', year: 2020, citation_count: 50,
      is_open_access: true, fields_of_study: ['Computer Science'], ...over,
    });

    beforeEach(() => svc.metadataFilterActive.set(true));

    it('year bounds (null year fails a set bound)', () => {
      svc.updateMetadata({ yearMin: 2018, yearMax: 2022 });
      const keep = svc.nodePredicate(false);
      expect(keep(node({ year: 2020 }))).toBe(true);
      expect(keep(node({ year: 2010 }))).toBe(false);
      expect(keep(node({ year: 2030 }))).toBe(false);
      expect(keep(node({ year: null }))).toBe(false);
    });

    it('citation bounds (null treated as 0)', () => {
      svc.updateMetadata({ citationMin: 10 });
      const keep = svc.nodePredicate(false);
      expect(keep(node({ citation_count: 50 }))).toBe(true);
      expect(keep(node({ citation_count: 5 }))).toBe(false);
      expect(keep(node({ citation_count: null }))).toBe(false);
    });

    it('open access only', () => {
      svc.updateMetadata({ openAccessOnly: true });
      const keep = svc.nodePredicate(false);
      expect(keep(node({ is_open_access: true }))).toBe(true);
      expect(keep(node({ is_open_access: false }))).toBe(false);
    });

    it('field of study (incl. Miscellaneous bucket)', () => {
      svc.setAllFields(false);
      svc.toggleField('Computer Science');
      const keep = svc.nodePredicate(false);
      expect(keep(node({ fields_of_study: ['Computer Science'] }))).toBe(true);
      expect(keep(node({ fields_of_study: ['Biology'] }))).toBe(false);
      // node with no fields excluded unless Miscellaneous selected
      expect(keep(node({ fields_of_study: [] }))).toBe(false);
      svc.toggleField('Miscellaneous');
      expect(svc.nodePredicate(false)(node({ fields_of_study: [] }))).toBe(true);
    });

    it('code / peer-reviewed / archetype enforced for seeds, passed through for expanded', () => {
      svc.updateMetadata({ codeOnly: true, peerReviewedOnly: true });
      const bad = node({ has_public_code: false, is_peer_reviewed: false });
      expect(svc.nodePredicate(true)(bad)).toBe(false);   // seed: enforced
      expect(svc.nodePredicate(false)(bad)).toBe(true);   // expanded: passed through

      svc.updateMetadata({ codeOnly: false, peerReviewedOnly: false });
      svc.setAllArchetypes(false);
      svc.toggleArchetype('The Innovator');
      const offArch = node({ predicted_main_archetype: 'The Analyst' });
      expect(svc.nodePredicate(true)(offArch)).toBe(false); // seed: enforced
      expect(svc.nodePredicate(false)(offArch)).toBe(true); // expanded: passed through
    });
  });

  describe('year-interval helpers', () => {
    it('mergeYearIntervals merges overlapping/adjacent, keeps disconnected', () => {
      // 1990 & 2010 each ±2 → two disjoint windows.
      expect(seedContextIntervals([1990, 2010], 2)).toEqual([[1988, 1992], [2008, 2012]]);
      // overlapping windows collapse.
      expect(seedContextIntervals([1990, 1993], 2)).toEqual([[1988, 1995]]);
      // adjacent (gap of exactly 1 year) collapse — no integer between them.
      expect(mergeYearIntervals([[1988, 1992], [1993, 1997]])).toEqual([[1988, 1997]]);
      // a true gap stays split.
      expect(mergeYearIntervals([[1988, 1992], [1995, 1997]])).toEqual([[1988, 1992], [1995, 1997]]);
    });

    it('seedContextIntervals: single seed ±3, drops null years, empty when none', () => {
      expect(seedContextIntervals([2000], 3)).toEqual([[1997, 2003]]);
      expect(seedContextIntervals([2000, null, undefined], 2)).toEqual([[1998, 2002]]);
      expect(seedContextIntervals([null, undefined], 3)).toEqual([]);
    });

    it('yearInIntervals: membership, null fails', () => {
      const ints: Array<[number, number]> = [[1988, 1992], [2008, 2012]];
      expect(yearInIntervals(1990, ints)).toBe(true);
      expect(yearInIntervals(2008, ints)).toBe(true);
      expect(yearInIntervals(2000, ints)).toBe(false);
      expect(yearInIntervals(null, ints)).toBe(false);
    });
  });

  describe('seed-context year mode (default)', () => {
    it('defaults to context mode but no-ops until seed windows arrive', () => {
      expect(svc.yearMode()).toBe('context');
      expect(svc.effectiveContextIntervals()).toBeNull();
      expect(svc.yearContextActive()).toBe(false);
      expect(svc.backendNodeFilter()).toBeNull();
    });

    it('seed config gates the build via year_intervals, even with metadata off', () => {
      svc.setAutoYearContext({ mode: 'seed', seedCount: 2, intervals: [[1988, 1992], [2008, 2012]] });
      expect(svc.yearContextActive()).toBe(true);
      // Backend payload carries the windows (metadata filter still off).
      expect(svc.backendNodeFilter()).toEqual({
        year_min: null, year_max: null, year_intervals: [[1988, 1992], [2008, 2012]],
        citation_min: null, citation_max: null, open_access_only: false, fields: [],
      });
      // Client predicate gates expanded nodes to the windows.
      const keep = svc.nodePredicate(false);
      expect(keep({ year: 1990 })).toBe(true);
      expect(keep({ year: 2009 })).toBe(true);
      expect(keep({ year: 2000 })).toBe(false); // disconnected gap
      expect(keep({ year: null })).toBe(false);
    });

    it('all config is a no-op (reports span but never narrows)', () => {
      svc.setAutoYearContext({ mode: 'all', seedCount: 0, intervals: [[1995, 2024]] });
      expect(svc.effectiveContextIntervals()).toBeNull();
      expect(svc.yearContextActive()).toBe(false);
      expect(svc.backendNodeFilter()).toBeNull();
      expect(svc.nodePredicate(false)({ year: null })).toBe(true); // null-year paper kept
    });

    it('custom range mode ignores the context windows', () => {
      svc.setAutoYearContext({ mode: 'seed', seedCount: 1, intervals: [[1997, 2003]] });
      svc.yearMode.set('range');
      expect(svc.effectiveContextIntervals()).toBeNull();
      expect(svc.backendNodeFilter()).toBeNull(); // no slider bound set + metadata off
      expect(svc.nodePredicate(false)({ year: 2030 })).toBe(true);
    });

    it('context windows supersede the slider year bound in the payload', () => {
      svc.setAutoYearContext({ mode: 'seed', seedCount: 1, intervals: [[1997, 2003]] });
      svc.metadataFilterActive.set(true);
      svc.updateMetadata({ yearMin: 2015, yearMax: 2020, citationMin: 10 });
      const payload = svc.backendNodeFilter();
      expect(payload?.year_intervals).toEqual([[1997, 2003]]);
      expect(payload?.year_min).toBeNull(); // slider bound dropped in favour of windows
      expect(payload?.year_max).toBeNull();
      expect(payload?.citation_min).toBe(10); // other metadata still applies
    });

    it('resetMetadata restores the default context mode', () => {
      svc.yearMode.set('range');
      svc.resetMetadata();
      expect(svc.yearMode()).toBe('context');
    });
  });
});
