/**
 * Guard for Seed-mode ok-graph builds: the graph must contain at least one expanded
 * (non-seed) paper. A graph of nothing but the hand-picked seeds carries no discovery
 * value, so we refuse to build it and surface a reason to the user instead.
 *
 * Seeds are hydrated at hop 0; every expanded neighbour is hop >= 1 (see the backend
 * `citgraph_builder._traverse`). So "has a non-seed node" === "some node has hop > 0".
 */

/** Minimal shape needed to tell seeds (hop 0) from expanded neighbours (hop >= 1). */
export interface HopNode {
  hop?: number;
}

/**
 * Returns an error message when a Seed-mode graph would contain only seeds (or nothing),
 * else `null` when it has at least one expanded paper and is safe to build.
 *
 * `filtering` tailors the message: when a filter is active the empty result is almost
 * always the filter's doing, so we point the user at loosening it.
 */
export function seedsOnlyGuardMessage(nodes: HopNode[], filtering: boolean): string | null {
  const hasNonSeed = nodes.some(n => (n.hop ?? 0) > 0);
  if (nodes.length > 0 && hasNonSeed) return null;
  return filtering
    ? 'No papers matched your filtering criteria. Try loosening the filters.'
    : 'No connected papers were found for the selected seeds.';
}
