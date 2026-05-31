import { CitGraphNode } from '../../core/services/citgraph.service';

/** Lower-cased haystack for a node: its title plus abstract. */
export function nodeMatchText(n: Pick<CitGraphNode, 'title' | 'abstract'>): string {
  return `${n.title ?? ''} ${n.abstract ?? ''}`.toLowerCase();
}

/**
 * Title + abstract keyword match. A node matches when ANY keyword appears as a
 * case-insensitive substring of its title/abstract. An empty keyword list
 * matches everything, so callers can treat "no keywords" as a filter no-op.
 */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  if (!keywords.length) return true;
  return keywords.some(k => k && text.includes(k.toLowerCase()));
}

/** Convenience: does this cit-graph node match the keyword query? */
export function matchesNodeKeywords(
  n: Pick<CitGraphNode, 'title' | 'abstract'>,
  keywords: string[],
): boolean {
  return matchesKeywords(nodeMatchText(n), keywords);
}
