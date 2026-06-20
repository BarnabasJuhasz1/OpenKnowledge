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

/** A contiguous slice of text, flagged as matching a keyword or not. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into alternating matched / unmatched segments so callers can
 * render the keyword hits (e.g. in bold). Matching is case-insensitive
 * substring matching with the same OR semantics as {@link matchesKeywords};
 * overlapping/adjacent hits are merged. Keywords shorter than 2 chars are
 * ignored to avoid noisy single-letter highlights. Concatenating every
 * segment's `text` reproduces the original input exactly.
 */
export function highlightSegments(text: string, keywords: string[]): HighlightSegment[] {
  if (!text) return [];
  const terms = keywords.map(k => k.trim().toLowerCase()).filter(k => k.length >= 2);
  if (!terms.length) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      ranges.push([idx, idx + term.length]);
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  if (!ranges.length) return [{ text, match: false }];

  // Merge overlapping/adjacent ranges so nested or touching hits become one bold run.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
