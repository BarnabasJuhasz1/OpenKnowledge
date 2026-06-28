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

/**
 * Whether base node `idx` should stay visible inside an entered (sub)cluster.
 *
 * Inside a drilled cluster the view normally shows only that cluster's members
 * (`communityAtLevel[idx] === clusterId`). Seed papers are the global anchors the
 * graph was built around, so when `isSeed` they remain visible inside *any* cluster
 * the user enters — keeping the origin of the graph on screen no matter how deep
 * the drill. Callers apply this only in the inner view; the main view shows
 * everything.
 */
export function passesInnerViewFilter(
  communityAtLevel: readonly number[],
  clusterId: number,
  idx: number,
  isSeed: boolean,
): boolean {
  return isSeed || communityAtLevel[idx] === clusterId;
}

/** Member count of each community in a level's base-node→community assignment. */
function communitySizes(comm: readonly number[]): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const c of comm) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  return sizes;
}

/**
 * Natural, hierarchical display labels for every cluster in a Louvain dendrogram.
 *
 * `communitiesByLevel[level][i]` is base node `i`'s community at hierarchy `level`,
 * for `level` 0 (finest) up to the top (coarsest, last entry). The returned array is
 * indexed the same way: `result[level]` maps a community id at that level to its
 * label.
 *
 * Numbering mirrors how the view is navigated, top-down:
 *   - the top-level clusters are "1", "2", … in DESCENDING size order (the biggest
 *     cluster is "1"), ties broken by ascending community id for stable output;
 *   - the sub-clusters one level finer inside parent "k" are "k.1", "k.2", … again
 *     by descending size within that parent — and so on, level by level, so a label
 *     like "2.3.1" reads as the largest sub-sub-cluster of the 3rd sub-cluster of
 *     the 2nd main cluster.
 *
 * The disconnected "Miscellaneous" top cluster (`miscTopCluster`, when present) is
 * pulled out of the 1..n numbering — it carries its own name in the UI — and given
 * the label "M" so any of its (rare) descendants still compose as "M.k".
 *
 * Labels are purely presentational; the numeric community ids stay the keys for
 * colours, summaries and selection.
 */
export function hierarchicalClusterLabels(
  communitiesByLevel: readonly (readonly number[])[],
  miscTopCluster: number | null = null,
): Map<number, string>[] {
  const top = communitiesByLevel.length - 1;
  const maps: Map<number, string>[] = communitiesByLevel.map(() => new Map<number, string>());
  if (top < 0) return maps;

  // Top level: number the non-misc clusters 1..n by descending size.
  const topSizes = communitySizes(communitiesByLevel[top]);
  const ranked = [...topSizes.keys()]
    .filter(c => c !== miscTopCluster)
    .sort((a, b) => (topSizes.get(b)! - topSizes.get(a)!) || (a - b));
  ranked.forEach((c, i) => maps[top].set(c, String(i + 1)));
  if (miscTopCluster != null) maps[top].set(miscTopCluster, 'M');

  // Finer levels: number each cluster within its parent by descending size, so the
  // label extends the parent's (e.g. parent "2" → children "2.1", "2.2", …).
  for (let lvl = top - 1; lvl >= 0; lvl--) {
    const comm = communitiesByLevel[lvl];
    const parentComm = communitiesByLevel[lvl + 1];
    const sizes = communitySizes(comm);
    const parentOf = new Map<number, number>();
    for (let i = 0; i < comm.length; i++) parentOf.set(comm[i], parentComm[i]);

    const kidsByParent = new Map<number, number[]>();
    for (const child of sizes.keys()) {
      const parent = parentOf.get(child)!;
      let arr = kidsByParent.get(parent);
      if (!arr) { arr = []; kidsByParent.set(parent, arr); }
      arr.push(child);
    }

    for (const [parent, kids] of kidsByParent) {
      kids.sort((a, b) => (sizes.get(b)! - sizes.get(a)!) || (a - b));
      const parentLabel = maps[lvl + 1].get(parent) ?? String(parent);
      kids.forEach((c, i) => maps[lvl].set(c, `${parentLabel}.${i + 1}`));
    }
  }
  return maps;
}
