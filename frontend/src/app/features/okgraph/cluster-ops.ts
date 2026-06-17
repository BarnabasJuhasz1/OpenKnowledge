/**
 * Pure helpers for OK-Graph cluster-level operations (e.g. the "remove this
 * cluster" trashcan on the on-graph cards). Kept free of Angular/signal deps so
 * the selection logic can be unit-tested on plain arrays; the component feeds in
 * its live placed nodes and community assignment.
 */

/** Minimal shape of a placed node needed to resolve its cluster. */
export interface ClusterMember {
  /** Stable id of the placed node (base-node paper id). */
  id: string;
  /** Base-node (Louvain) index, used to look up its community. */
  repIndex: number;
}

/**
 * Ids of every placed node belonging to `topCluster` at the current view level.
 *
 * `communityAtLevel[i]` is node `i`'s community at the level currently shown
 * (top level in the main view, the sub-level inside an entered cluster). Because
 * Louvain community ids are globally unique per level, matching on the id alone
 * isolates a single cluster in the main view or a single subcluster in an inner
 * view — so this drives removing a whole (sub)cluster as one action.
 */
export function placedIdsInCluster(
  placed: readonly ClusterMember[],
  communityAtLevel: readonly number[],
  topCluster: number,
): string[] {
  return placed
    .filter(p => communityAtLevel[p.repIndex] === topCluster)
    .map(p => p.id);
}

/**
 * Number of distinct sub-clusters (communities one level finer) contained in
 * `topCluster`. `parentComm[i]` / `childComm[i]` are node `i`'s community at the
 * current view level and the level immediately below it. Counts how many child
 * communities the cluster's members fan out into — i.e. the cluster card's
 * "M sub-clusters" figure. At the leaf level the child community is each node's
 * own index, so the count would equal the paper count; callers only show it when
 * a finer level actually exists.
 */
export function subclusterCount(
  parentComm: readonly number[],
  childComm: readonly number[],
  topCluster: number,
): number {
  const subs = new Set<number>();
  for (let i = 0; i < parentComm.length; i++) {
    if (parentComm[i] === topCluster) subs.add(childComm[i]);
  }
  return subs.size;
}
