/** Geometry for the "slide nodes out of the way of a wrapped title" effect.
 *
 *  When a node is hovered/selected its title wraps to several lines, so the nodes
 *  stacked directly beneath it must slide down to make room. Only the *contiguous*
 *  stack immediately below should move: once there is a vertical gap wider than a
 *  single node slot between two groups, the lower group is visually separate and
 *  must stay put. Walking the column top-down and breaking at the first such gap
 *  gives that behaviour. */

export interface PushNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Ids of the nodes forming the contiguous vertical run directly below `expanded`
 *  (within `reach` horizontally), stopping before the first vertical gap larger
 *  than `maxChainGap`. The expanded node itself is never included. */
export function nodesPushedBelow(
  expanded: PushNode,
  nodes: ReadonlyArray<PushNode>,
  reach: number,
  maxChainGap: number,
): string[] {
  const below = nodes
    .filter(n => n.id !== expanded.id && n.y > expanded.y && Math.abs(n.x - expanded.x) < reach)
    .sort((a, b) => a.y - b.y);

  const out: string[] = [];
  let prevY = expanded.y;
  for (const n of below) {
    if (n.y - prevY > maxChainGap) break;   // a clear gap → lower group is separate
    out.push(n.id);
    prevY = n.y;
  }
  return out;
}
