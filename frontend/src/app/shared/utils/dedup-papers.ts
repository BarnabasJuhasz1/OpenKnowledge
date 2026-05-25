import { Paper } from '../../core/models/paper.model';

/**
 * Normalize a DOI for comparison: lowercase, strip common URL prefixes.
 */
function normDoi(doi: string | null): string | null {
  if (!doi) return null;
  return doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase().trim() || null;
}

/**
 * Strip arXiv version suffix (e.g. "2301.00001v2" → "2301.00001").
 */
function normArxiv(id: string | null): string | null {
  if (!id) return null;
  return id.replace(/v\d+$/, '').trim() || null;
}

/**
 * Normalize a title for fuzzy comparison: lowercase, strip non-alphanumeric.
 */
function normTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

export interface DedupResult {
  /** Unique papers with merged `sources` lists. */
  papers: Paper[];
  /** How many raw papers were removed as duplicates. */
  duplicatesRemoved: number;
}

/**
 * Deduplicate papers across sources.
 *
 * Matches by DOI, arXiv ID, other database IDs, then exact normalized title+year.
 * Merged papers get the union of all `sources`.
 */
export function deduplicatePapers(raw: Paper[]): DedupResult {
  const groups: Paper[][] = [];

  // Index maps: normalized key → group index
  const doiIdx = new Map<string, number>();
  const arxivIdx = new Map<string, number>();
  const ssIdx = new Map<string, number>();
  const oaIdx = new Map<string, number>();
  const pmIdx = new Map<string, number>();
  const titleYearIdx = new Map<string, number>();

  function findGroup(p: Paper): number | null {
    const doi = normDoi(p.doi);
    if (doi && doiIdx.has(doi)) return doiIdx.get(doi)!;

    const arxiv = normArxiv(p.arxiv_id);
    if (arxiv && arxivIdx.has(arxiv)) return arxivIdx.get(arxiv)!;

    if (p.semantic_scholar_id && ssIdx.has(p.semantic_scholar_id))
      return ssIdx.get(p.semantic_scholar_id)!;
    if (p.openalex_id && oaIdx.has(p.openalex_id))
      return oaIdx.get(p.openalex_id)!;
    if (p.pubmed_id && pmIdx.has(p.pubmed_id))
      return pmIdx.get(p.pubmed_id)!;

    const nt = normTitle(p.title);
    if (nt) {
      const key = `${nt}||${p.year ?? ''}`;
      if (titleYearIdx.has(key)) return titleYearIdx.get(key)!;
    }

    return null;
  }

  function register(p: Paper, gidx: number): void {
    const doi = normDoi(p.doi);
    if (doi) doiIdx.set(doi, gidx);
    const arxiv = normArxiv(p.arxiv_id);
    if (arxiv) arxivIdx.set(arxiv, gidx);
    if (p.semantic_scholar_id) ssIdx.set(p.semantic_scholar_id, gidx);
    if (p.openalex_id) oaIdx.set(p.openalex_id, gidx);
    if (p.pubmed_id) pmIdx.set(p.pubmed_id, gidx);
    const nt = normTitle(p.title);
    if (nt) titleYearIdx.set(`${nt}||${p.year ?? ''}`, gidx);
  }

  for (const paper of raw) {
    const gidx = findGroup(paper);
    if (gidx != null) {
      groups[gidx].push(paper);
      register(paper, gidx);
    } else {
      const newIdx = groups.length;
      groups.push([paper]);
      register(paper, newIdx);
    }
  }

  // Merge each group: keep the first paper's data, but union sources
  const merged: Paper[] = groups.map(group => {
    if (group.length === 1) return group[0];
    const base = { ...group[0] };
    const allSources = new Set<string>();
    for (const p of group) {
      for (const s of p.sources) allSources.add(s);
    }
    base.sources = Array.from(allSources);
    return base;
  });

  return {
    papers: merged,
    duplicatesRemoved: raw.length - merged.length,
  };
}
