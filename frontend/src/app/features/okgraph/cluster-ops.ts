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
 * Ids of EVERY base node belonging to `topCluster` at the current view level —
 * including ones not currently placed on the canvas. Unlike `placedIdsInCluster`
 * (which only sees placed nodes), this resolves the cluster's full membership so a
 * "remove cluster" action can permanently exclude every paper in it, not just the
 * visible representatives. `communityAtLevel[i]` / `baseIds[i]` describe base node
 * `i` at the level currently shown.
 */
export function baseIdsInCluster(
  communityAtLevel: readonly number[],
  baseIds: readonly string[],
  topCluster: number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < communityAtLevel.length; i++) {
    if (communityAtLevel[i] === topCluster) out.push(baseIds[i]);
  }
  return out;
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
  return subclusterCommunities(parentComm, childComm, topCluster).length;
}

/**
 * Distinct child community ids (one level finer) contained in `topCluster`. Same
 * scan as `subclusterCount` but returns the ids themselves, so a caller entering a
 * cluster can resolve and place each sub-cluster's representative. `parentComm[i]` /
 * `childComm[i]` are node `i`'s community at the current view level and the level
 * immediately below it. At the leaf level the child community is each node's own
 * index, so this yields one entry per paper in the cluster.
 */
export function subclusterCommunities(
  parentComm: readonly number[],
  childComm: readonly number[],
  topCluster: number,
): number[] {
  const subs = new Set<number>();
  for (let i = 0; i < parentComm.length; i++) {
    if (parentComm[i] === topCluster) subs.add(childComm[i]);
  }
  return [...subs];
}
