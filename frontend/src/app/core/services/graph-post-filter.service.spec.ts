import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphPostFilterService } from './graph-post-filter.service';
import { NodeLike } from './graph-filter.service';
import { ALL_ARCHETYPES, ALL_SELECTABLE_FIELDS } from './search-state.service';

describe('GraphPostFilterService', () => {
  let svc: GraphPostFilterService;

  const node = (over: Partial<NodeLike>): NodeLike => ({
    title: 't', abstract: 'a', year: 2020, citation_count: 50,
    is_open_access: true, fields_of_study: ['Computer Science'],
    has_public_code: true, is_peer_reviewed: true,
    predicted_main_archetype: 'The Innovator', ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(GraphPostFilterService);
  });

  it('defaults to a no-op filter (keeps every node)', () => {
    expect(svc.hasActiveFilter()).toBe(false);
    expect(svc.metadata().archetypes.size).toBe(ALL_ARCHETYPES.length);
    expect(svc.metadata().fields.size).toBe(ALL_SELECTABLE_FIELDS.length);
    const keep = svc.nodePredicate(true);
    expect(keep(node({ year: 1990, citation_count: 0, is_open_access: false }))).toBe(true);
  });

  it('hides non-matching nodes once a constraint is set', () => {
    svc.updateMetadata({ citationMin: 10 });
    expect(svc.hasActiveFilter()).toBe(true);
    const keep = svc.nodePredicate(true);
    expect(keep(node({ citation_count: 50 }))).toBe(true);
    expect(keep(node({ citation_count: 5 }))).toBe(false);
  });

  it('reset reveals every node again (revertible)', () => {
    svc.updateMetadata({ yearMin: 2015, openAccessOnly: true });
    const blocked = node({ year: 2000, is_open_access: false });
    expect(svc.nodePredicate(false)(blocked)).toBe(false);

    svc.resetMetadata();
    expect(svc.hasActiveFilter()).toBe(false);
    expect(svc.nodePredicate(false)(blocked)).toBe(true);
  });

  it('code / peer-reviewed / archetype enforced for seeds, passed through for expanded', () => {
    svc.updateMetadata({ codeOnly: true, peerReviewedOnly: true });
    const bad = node({ has_public_code: false, code_url: null, is_peer_reviewed: false });
    expect(svc.nodePredicate(true)(bad)).toBe(false);   // seed: enforced
    expect(svc.nodePredicate(false)(bad)).toBe(true);   // expanded: passed through

    svc.updateMetadata({ codeOnly: false, peerReviewedOnly: false });
    svc.setAllArchetypes(false);
    svc.toggleArchetype('The Innovator');
    const offArch = node({ predicted_main_archetype: 'The Analyst', predicted_second_tier_archetype: null });
    expect(svc.nodePredicate(true)(offArch)).toBe(false); // seed: enforced
    expect(svc.nodePredicate(false)(offArch)).toBe(true); // expanded: passed through
  });

  it('field of study filter (incl. Miscellaneous bucket for fieldless nodes)', () => {
    svc.setAllFields(false);
    svc.toggleField('Computer Science');
    const keep = svc.nodePredicate(false);
    expect(keep(node({ fields_of_study: ['Computer Science'] }))).toBe(true);
    expect(keep(node({ fields_of_study: ['Biology'] }))).toBe(false);
    expect(keep(node({ fields_of_study: [] }))).toBe(false);
    svc.toggleField('Miscellaneous');
    expect(svc.nodePredicate(false)(node({ fields_of_study: [] }))).toBe(true);
  });

  it('is independent — no Set reference shared between resets', () => {
    const first = svc.metadata().fields;
    svc.resetMetadata();
    expect(svc.metadata().fields).not.toBe(first);
  });
});
