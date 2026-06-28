/**
 * Vertical level placement for the ok-graph cluster bands.
 *
 * Each cluster (lane) sits at one fixed vertical level. A cluster's blob grows
 * by its tallest stacked `(cluster, year)` cell — `halfExtent` px above and below
 * its centre — plus the blob padding. If consecutive levels were spaced by a fixed
 * constant the padded blobs of tall stacks would overlap (see bug: stacked nodes
 * of neighbouring clusters touching). `computeLevelCenters` instead places levels
 * cumulatively so neighbours are always far enough apart that their padded blobs
 * never collide, while never packing tighter than `bandSpacing` for short stacks.
 */
export interface LevelSpacingOpts {
  /** Minimum centre-to-centre spacing between adjacent levels (short-stack default). */
  bandSpacing: number;
  /** Blob padding above the top-most node centre of a level. */
  padTop: number;
  /** Blob padding below the bottom-most node centre of a level. */
  padBottom: number;
  /** Minimum clear gap left between two padded blobs. */
  minClear: number;
}

/**
 * Cumulative relative level centres, one per rank, in lane order.
 * `halfExtents[i]` is the node-centre half-height of rank `i`'s tallest cell.
 * Returns an array the same length as `halfExtents`, with `centers[0] === 0`.
 */
export function computeLevelCenters(halfExtents: number[], opts: LevelSpacingOpts): number[] {
  const { bandSpacing, padTop, padBottom, minClear } = opts;
  const centers: number[] = [];
  if (!halfExtents.length) return centers;
  centers.push(0);
  for (let i = 1; i < halfExtents.length; i++) {
    const needed = halfExtents[i - 1] + padBottom + minClear + padTop + halfExtents[i];
    centers.push(centers[i - 1] + Math.max(bandSpacing, needed));
  }
  return centers;
}

/**
 * Interpolate the level centre at a (possibly fractional) rank, so the seed —
 * whose rank may be the average of several clusters — can be re-centred to 0.
 * Clamps to the ends; returns 0 for an empty layout.
 */
export function levelCenterAtRank(centers: number[], rank: number): number {
  if (!centers.length) return 0;
  if (rank <= 0) return centers[0];
  if (rank >= centers.length - 1) return centers[centers.length - 1];
  const lo = Math.floor(rank);
  const frac = rank - lo;
  return centers[lo] + (centers[lo + 1] - centers[lo]) * frac;
}

/** Which side of the seed a cluster's blob funnels into. */
export type ClusterSide = 'left' | 'right' | 'span';

/**
 * Pack the cluster lanes into relative vertical positions, packing the LEFT and
 * RIGHT columns independently.
 *
 * Every cluster funnels into one side of the seed (`left` / `right`) or spans it.
 * Clusters that span the seed (and the seed's own cluster) are full-width and stack
 * down a central column. A left cluster and a right cluster never overlap
 * horizontally, so each side fans out above / below that centre band *on its own* —
 * spaced only by its own clusters' extents. This is the key over a shared level grid:
 * a short left cluster hugs the centre even when the opposite (right) side is tall,
 * so filtering away one side's clusters never leaves a gap sized by the other side.
 *
 * Returns each cluster's relative y centre, with the seed cluster(s) centred at 0.
 *
 * @param order         lane order (priority), e.g. connectivity seriation — earliest
 *                      clusters land nearest the centre.
 * @param sideOf        side classification per cluster (missing → treated as `span`).
 * @param halfExtentOf  tallest-stacked-cell half-height per cluster (missing → 0).
 * @param seedClusters  clusters that contain a seed paper — always centred.
 * @param opts          spacing options (shared with computeLevelCenters).
 */
export function packClusterBands(
  order: number[],
  sideOf: Map<number, ClusterSide>,
  halfExtentOf: Map<number, number>,
  seedClusters: Set<number>,
  opts: LevelSpacingOpts,
): Map<number, number> {
  const half = (c: number) => halfExtentOf.get(c) ?? 0;
  const relY = new Map<number, number>();

  // Central column: the seed's own cluster(s) plus any non-seed cluster that spans
  // the seed (members on both sides) — both are full-width and can't share a row
  // with a one-sided cluster, so they stack down the middle.
  const centerCol = order.filter(c => seedClusters.has(c) || (sideOf.get(c) ?? 'span') === 'span');
  const leftCol = order.filter(c => !seedClusters.has(c) && sideOf.get(c) === 'left');
  const rightCol = order.filter(c => !seedClusters.has(c) && sideOf.get(c) === 'right');

  // Place the centre column, shifted so the seed clusters' mean sits at relative 0
  // (falling back to the column midpoint when no member is a seed).
  let topAnchorY = 0, topAnchorHalf = 0, bottomAnchorY = 0, bottomAnchorHalf = 0;
  if (centerCol.length) {
    const centers = computeLevelCenters(centerCol.map(half), opts);
    const seedIdx = centerCol.map((c, i) => (seedClusters.has(c) ? i : -1)).filter(i => i >= 0);
    const refIdx = seedIdx.length ? seedIdx : centerCol.map((_, i) => i);
    const shift = refIdx.reduce((s, i) => s + centers[i], 0) / refIdx.length;
    centerCol.forEach((c, i) => relY.set(c, centers[i] - shift));
    topAnchorY = centers[0] - shift;
    topAnchorHalf = half(centerCol[0]);
    bottomAnchorY = centers[centers.length - 1] - shift;
    bottomAnchorHalf = half(centerCol[centerCol.length - 1]);
  }

  // Fan one side's clusters above and below the centre band, spaced by THIS side's
  // extents only (independent of the other side). Earliest clusters hug the centre.
  const fan = (col: number[]) => {
    const below: number[] = [], above: number[] = [];
    col.forEach((c, i) => (i % 2 === 0 ? below : above).push(c));
    if (below.length) {
      // Stack downward from the bottom anchor: prepend the anchor as a 0-index seed.
      const centers = computeLevelCenters([bottomAnchorHalf, ...below.map(half)], opts);
      below.forEach((c, i) => relY.set(c, bottomAnchorY + centers[i + 1]));
    }
    if (above.length) {
      // Stack upward from the top anchor (mirror of the downward centres).
      const centers = computeLevelCenters([topAnchorHalf, ...above.map(half)], opts);
      above.forEach((c, i) => relY.set(c, topAnchorY - centers[i + 1]));
    }
  };
  fan(leftCol);
  fan(rightCol);

  return relY;
}
