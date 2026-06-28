import { describe, it, expect } from 'vitest';
import { nodesPushedBelow, PushNode } from './title-push';

// In-stack vertical spacing is 64px (LANE_NODE_VGAP); a gap wider than one empty
// slot separates groups. Tests use maxChainGap = 96 (= 64 * 1.5) to match the
// component, and reach = 97 (LABEL_WRAP_WIDTH/2 + NODE_R).
const GAP = 96;
const REACH = 97;

const node = (id: string, x: number, y: number): PushNode => ({ id, x, y });

describe('nodesPushedBelow', () => {
  it('pushes a contiguous stack directly below', () => {
    const expanded = node('e', 100, 0);
    const nodes = [expanded, node('a', 100, 64), node('b', 100, 128), node('c', 100, 192)];
    expect(nodesPushedBelow(expanded, nodes, REACH, GAP)).toEqual(['a', 'b', 'c']);
  });

  it('stops at the first vertical gap wider than one node slot', () => {
    const expanded = node('e', 100, 0);
    const nodes = [
      expanded,
      node('a', 100, 64),   // contiguous
      node('b', 100, 128),  // contiguous
      // gap: next at 320 (192px below b) -> separate lower group
      node('c', 100, 320),
      node('d', 100, 384),
    ];
    expect(nodesPushedBelow(expanded, nodes, REACH, GAP)).toEqual(['a', 'b']);
  });

  it('ignores nodes above and the expanded node itself', () => {
    const expanded = node('e', 100, 100);
    const nodes = [node('above', 100, 36), expanded, node('below', 100, 164)];
    expect(nodesPushedBelow(expanded, nodes, REACH, GAP)).toEqual(['below']);
  });

  it('ignores nodes outside the horizontal reach', () => {
    const expanded = node('e', 100, 0);
    const nodes = [expanded, node('far', 100 + REACH, 64), node('near', 100, 64)];
    expect(nodesPushedBelow(expanded, nodes, REACH, GAP)).toEqual(['near']);
  });

  it('returns nothing when the first node below is already past a gap', () => {
    const expanded = node('e', 100, 0);
    const nodes = [expanded, node('a', 100, 200)];
    expect(nodesPushedBelow(expanded, nodes, REACH, GAP)).toEqual([]);
  });
});
