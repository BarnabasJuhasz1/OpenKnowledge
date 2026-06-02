/**
 * Per-cluster, year-filtered candidate queues for the OK-Graph "expand year"
 * action.
 *
 * When the user selects a year on the OK-Graph axis and presses Expand, every
 * lane cluster currently shown gains one node strictly from that year. The node
 * is the cluster's qualifying paper at the *highest hierarchy level it still
 * represents* (a coarse sub-cluster, or an individual paper / leaf if it
 * represents nothing finer), breaking ties by ok-score. Repeated presses drill
 * down the per-cluster queue.
 *
 * This module holds the pure enumeration/sort so it can be unit-tested on plain
 * arrays; the component maps the result onto its `PlacedNode`s.
 */

/**
 * The year(s) that sit literally in the middle of the inclusive range
 * `[leftYear, rightYear]`. Used by the OK-Graph "expand in-between years" action.
 *
 * An odd-length range has a single centre year (`2010..2014` → `[2012]`); an
 * even-length range has the two centre years (`2010..2019` → `[2014, 2015]`).
 */
export function middleYears(leftYear: number, rightYear: number): number[] {
  const sum = leftYear + rightYear;
  return sum % 2 === 0 ? [sum / 2] : [(sum - 1) / 2, (sum + 1) / 2];
}

export interface YearCandidate {
  /** Base-node (Louvain) index of the candidate paper. */
  paperIndex: number;
  /** Highest hierarchy level the paper represents (-1 = individual paper / leaf). */
  level: number;
  /** Community id at `level` (or `paperIndex` itself for a leaf). */
  community: number;
}

export interface YearExpandOptions {
  /** `commAtLevel[L][i]` = community of node `i` at level `L`, for `L` in `0..currentTopLevel`. */
  commAtLevel: number[][];
  /** Coarsest level considered (top level in the main view, top-1 inside a cluster). */
  currentTopLevel: number;
  /** Publication year per node (or null when unknown). */
  nodeYear: (number | null)[];
  /** Representative score per node — drives the rep choice and the score-desc sort. */
  nodeScore: number[];
  /** Lane cluster id per node in the current view. */
  laneClusterOf: number[];
  /** Whether each node is part of the current view. */
  inView: boolean[];
  /** The year the user selected. */
  selectedYear: number;
  /** Whether a given base-node index is already placed on the canvas. */
  isPlaced: (paperIndex: number) => boolean;
}

/**
 * Build the ordered candidate queue for each lane cluster. Each queue holds the
 * not-yet-placed candidate nodes from `selectedYear`, sorted by level descending
 * then score descending (lower index breaks remaining ties for determinism).
 */
export function yearExpandQueues(opts: YearExpandOptions): Map<number, YearCandidate[]> {
  const {
    commAtLevel, currentTopLevel, nodeYear, nodeScore,
    laneClusterOf, inView, selectedYear, isPlaced,
  } = opts;

  const n = nodeYear.length;

  // Representative (max-score, lower-index tie-break) per community at each level.
  // Mirrors repIndexOfCluster's strict `>` comparison: the first-seen max wins.
  const repAt: Map<number, number>[] = [];
  for (let L = 0; L <= currentTopLevel; L++) {
    const comm = commAtLevel[L];
    const best = new Map<number, number>();      // community -> rep index
    for (let i = 0; i < n; i++) {
      const c = comm[i];
      const cur = best.get(c);
      if (cur === undefined || nodeScore[i] > nodeScore[cur]) best.set(c, i);
    }
    repAt[L] = best;
  }

  const highestRepLevel = (i: number): number => {
    for (let L = currentTopLevel; L >= 0; L--) {
      if (repAt[L].get(commAtLevel[L][i]) === i) return L;
    }
    return -1; // represents nothing finer → individual paper (leaf)
  };

  const queues = new Map<number, YearCandidate[]>();
  for (let i = 0; i < n; i++) {
    if (!inView[i]) continue;
    if (nodeYear[i] !== selectedYear) continue;
    if (isPlaced(i)) continue;

    const level = highestRepLevel(i);
    const community = level >= 0 ? commAtLevel[level][i] : i;
    const cluster = laneClusterOf[i];

    let q = queues.get(cluster);
    if (!q) { q = []; queues.set(cluster, q); }
    q.push({ paperIndex: i, level, community });
  }

  for (const q of queues.values()) {
    q.sort((a, b) =>
      (b.level - a.level) ||
      (nodeScore[b.paperIndex] - nodeScore[a.paperIndex]) ||
      (a.paperIndex - b.paperIndex),
    );
  }

  return queues;
}
