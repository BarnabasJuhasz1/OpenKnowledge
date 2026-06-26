/**
 * Admin / testing knobs for how the OK-Graph builds the surrounding citation
 * graph when you press "Explore".
 *
 * This is the SINGLE place to change these values. Edit the constants below,
 * rebuild, and they take effect everywhere — there is no UI control and no
 * per-project override. Intended for maintainer tuning before deploying with the
 * chosen values, not for end users.
 */
export interface AdminGraphConfig {
  /** Neighbourhood depth: how many citation hops out from each seed paper. */
  K_HOPS: number;
  /**
   * Cumulative cap on the total number of new papers added in a hop across all
   * frontier papers, or `null` for no limit. Keeps the highest-ok-score papers
   * (ranked by citation count).
   */
  MAX_PER_HOP: number | null;
  /**
   * Of the references/citers fetched for a single paper, *keep* only the top K
   * with the highest ok-score, or `null` to keep all. Can be specified per hop
   * level as an array (e.g. `[null, 30]`). If the array is shorter than K_HOPS,
   * the last element is reused for subsequent hops.
   *
   * Ranking is by `citation_count`: expanded neighbours are not ok-score-enriched
   * (enrichment only matches papers in the active project's DB), so their
   * ok-score reduces to `w_c·log10(1 + citation_count)` — monotonic in
   * `citation_count`. So "top K by ok-score" == "top K by citation_count" here.
   *
   * For a foundational paper: set `MAX_PER_HOP = null` (fetch all citers) and
   * `TOP_K_PER_PAPER` to the number of highest-cited ones you want to keep.
   */
  TOP_K_PER_PAPER: (number | null)[] | null;
  /** Louvain clustering resolution. Higher → more, smaller clusters. */
  RESOLUTION: number;
}

/**
 * Which OK-Graph construction mode a config applies to. These mirror the
 * "Seed" / "All" tabs in the build panel:
 *  - `'seed'`: expand citation neighbourhoods outward from the selected seed
 *    papers (all knobs apply).
 *  - `'all'`: build the graph from every retrieved search result client-side
 *    (only `RESOLUTION` affects the result; the other knobs are kept for
 *    symmetry and future use).
 */
export type GraphBuildMode = 'seed' | 'all';

/**
 * Per-mode graph-build settings. Pick the entry matching the active
 * construction mode: `ADMIN_GRAPH_CONFIG['seed']` or `ADMIN_GRAPH_CONFIG['all']`.
 */
/**
 * When `true`, the OK-Graph's seed-mode citation expansion keeps ONLY Semantic
 * Scholar "highly influential" citation edges: every non-influential edge is
 * dropped *before* the graph is traversed, so the papers those edges point to
 * are never added as nodes and are never expanded from on later hops either.
 * `false` (default) keeps every edge.
 *
 * Scope: only the seed/hosted build path can honour this, because its edges come
 * from the BigQuery citation tables that carry S2's per-edge `isinfluential`
 * flag. The client-side `'all'` mode (edges rebuilt from paper reference lists)
 * and the demo dataset have no per-edge influence signal, so the toggle has no
 * effect there.
 */
export const INFLUENTIAL_CITATIONS_ONLY: boolean = false;

export const ADMIN_GRAPH_CONFIG: Record<GraphBuildMode, AdminGraphConfig> = {
  seed: {
    K_HOPS: 2,
    MAX_PER_HOP: null,
    TOP_K_PER_PAPER: [100, 30],
    RESOLUTION: 0.5,
  },
  all: {
    K_HOPS: 2,
    MAX_PER_HOP: null,
    TOP_K_PER_PAPER: [100, 30],
    RESOLUTION: 0.5,
  },
};

/**
 * Graph-build settings for the **v2** ("direction-pure cones") construction —
 * used in place of `ADMIN_GRAPH_CONFIG` when the v2 flip is on AND the direction
 * is `'both'` (the only case where v2 differs from v1).
 *
 * Why a separate config: v2's `'both'` build runs TWO independent traversals — a
 * pure future cone (citations) and a pure past cone (references) — and each cone
 * receives the per-paper / per-hop caps in full and independently. v1's mixed
 * `'both'` traversal instead shares ONE budget across references and citations.
 * So at identical caps v2 hands out roughly DOUBLE the neighbours per paper. To
 * keep the two versions budget-matched (each cone's share == v1's combined
 * share), the values below are the `ADMIN_GRAPH_CONFIG` values halved.
 *
 * Keep these in sync with `ADMIN_GRAPH_CONFIG` when tuning: `K_HOPS` and
 * `RESOLUTION` should match v1 (they aren't per-direction budgets); `MAX_PER_HOP`
 * and `TOP_K_PER_PAPER` should be the v1 values halved. Only the `seed` entry is
 * ever consulted (v2 is seed-mode only); `all` mirrors v1 for symmetry.
 */
export const ADMIN_GRAPH_CONFIG_V2: Record<GraphBuildMode, AdminGraphConfig> = {
  seed: {
    K_HOPS: 2,
    MAX_PER_HOP: null,
    TOP_K_PER_PAPER: [50, 15],
    RESOLUTION: 0.5,
  },
  all: {
    K_HOPS: 2,
    MAX_PER_HOP: null,
    TOP_K_PER_PAPER: [50, 15],
    RESOLUTION: 0.5,
  },
};