const STRIP_TOKENS = new Set(['AND', 'OR', 'NOT', 'and', 'or', 'not']);

/**
 * Converts a raw boolean query string into a flat keyword list for the backend.
 *
 * Rules:
 *  - Negated phrases (-"...") and negated words (-word) → removed entirely
 *  - "quoted phrases" → single keyword (quotes stripped)
 *  - Boolean operators (AND, OR, NOT), parentheses → removed
 *  - Remaining tokens split on whitespace → individual keywords
 *  - Short all-caps abbreviations like LLM kept as-is
 */
export function parseQuery(raw: string): string[] {
  const keywords: string[] = [];

  // 1. Strip negated phrases and negated words FIRST (before extracting positives)
  let cleaned = raw
    .replace(/-"[^"]*"/g, '')  // remove negated phrases like -"retrieval-augmented"
    .replace(/-\S+/g, '');     // remove negated words like -RAG

  // 2. Extract quoted phrases from the cleaned string
  const quotedRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = quotedRe.exec(cleaned)) !== null) {
    const phrase = match[1].trim();
    if (phrase) keywords.push(phrase);
  }

  // 3. Remove quoted phrases and boolean syntax from remaining text
  cleaned = cleaned
    .replace(/"[^"]*"/g, '')   // remove quoted phrases (already extracted)
    .replace(/[()]/g, ' ');    // remove parentheses

  // 4. Split on whitespace and filter out boolean operators
  const tokens = cleaned.split(/\s+/).filter(t => {
    if (!t || t.length < 2) return false;
    if (STRIP_TOKENS.has(t)) return false;
    return true;
  });

  keywords.push(...tokens);

  // 5. Deduplicate preserving order
  const seen = new Set<string>();
  return keywords.filter(k => {
    const lower = k.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}
