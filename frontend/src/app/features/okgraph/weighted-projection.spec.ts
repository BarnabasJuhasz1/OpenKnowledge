import { describe, it, expect } from 'vitest';
import { buildRetrievedProjection, ProjectionEdge } from './weighted-projection';

/** Find the projected edge for an unordered retained pair, if any. */
function edge(edges: ProjectionEdge[], a: number, b: number): ProjectionEdge | undefined {
  return edges.find(
    e => (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
}

describe('buildRetrievedProjection', () => {
  it('links two retained papers by their shared intermediate connectors', () => {
    // retained: 0,1,2 ; intermediates: 3,4,5. Papers 0 and 1 each cite the three
    // connectors (co-citation), 2 cites nothing shared.
    const retainedCount = 3;
    const fullNodeCount = 6;
    const edges = [
      { source: 0, target: 3 }, { source: 1, target: 3 },
      { source: 0, target: 4 }, { source: 1, target: 4 },
      { source: 0, target: 5 }, { source: 1, target: 5 },
    ];
    const proj = buildRetrievedProjection(retainedCount, fullNodeCount, edges, {
      hubDiscount: 'none',
    });
    // One edge (0,1) weighted by the 3 shared connectors; node 2 isolated.
    expect(proj.length).toBe(1);
    expect(edge(proj, 0, 1)!.weight).toBe(3);
    expect(edge(proj, 0, 2)).toBeUndefined();
    expect(edge(proj, 1, 2)).toBeUndefined();
  });

  it('discounts hub connectors so they tie papers together only weakly', () => {
    // A single hub connector (3) cites all three retained papers.
    const edges = [
      { source: 0, target: 3 }, { source: 1, target: 3 }, { source: 2, target: 3 },
    ];
    // minWeight 0 so the discounted edges survive and their raw weights can be compared.
    const wNone = edge(buildRetrievedProjection(3, 4, edges, { hubDiscount: 'none', minWeight: 0 }), 0, 1)!.weight;
    const wAdamic = edge(buildRetrievedProjection(3, 4, edges, { hubDiscount: 'adamic-adar', minWeight: 0 }), 0, 1)!.weight;
    const wInverse = edge(buildRetrievedProjection(3, 4, edges, { hubDiscount: 'inverse-degree', minWeight: 0 }), 0, 1)!.weight;
    // The bigger the hub, the cheaper its contribution: none > adamic-adar > inverse-degree.
    expect(wNone).toBe(1);
    expect(wAdamic).toBeLessThan(wNone);
    expect(wInverse).toBeLessThan(wAdamic);
  });

  it('connector touching a single retained paper produces no edge', () => {
    // 3 connects only to retained 0 (plus an intermediate 4) — relates nothing.
    const edges = [
      { source: 0, target: 3 }, { source: 3, target: 4 },
    ];
    const proj = buildRetrievedProjection(2, 5, edges, { hubDiscount: 'none' });
    expect(proj.length).toBe(0);
  });

  it('direct-edge bonus lifts a directly-citing pair over the threshold', () => {
    // 0 and 1 cite each other directly and share one connector (3). Without the
    // bonus the weight would be 1 (one shared connector) and a minWeight of 1.5
    // would drop it; the bonus pushes it to 2.
    const edges = [
      { source: 0, target: 1 },
      { source: 0, target: 3 }, { source: 1, target: 3 },
    ];
    const noBonus = buildRetrievedProjection(2, 4, edges, {
      hubDiscount: 'none', minWeight: 1.5, directEdgeBonus: 0,
    });
    expect(noBonus.length).toBe(0);

    const withBonus = buildRetrievedProjection(2, 4, edges, {
      hubDiscount: 'none', minWeight: 1.5, directEdgeBonus: 1,
    });
    expect(edge(withBonus, 0, 1)!.weight).toBe(2);
  });

  it('raising minWeight sparsifies the graph (the Miscellaneous dial)', () => {
    // 0 & 1 share 2 connectors (weight 2); 1 & 2 share 1 connector (weight 1).
    const edges = [
      { source: 0, target: 3 }, { source: 1, target: 3 },
      { source: 0, target: 4 }, { source: 1, target: 4 },
      { source: 1, target: 5 }, { source: 2, target: 5 },
    ];
    const loose = buildRetrievedProjection(3, 6, edges, { hubDiscount: 'none', minWeight: 1 });
    expect(loose.length).toBe(2); // both pairs survive

    const strict = buildRetrievedProjection(3, 6, edges, { hubDiscount: 'none', minWeight: 2 });
    expect(strict.length).toBe(1); // only the strong (0,1) pair; node 2 now isolated
    expect(edge(strict, 0, 1)).toBeDefined();
    expect(edge(strict, 1, 2)).toBeUndefined();
  });

  it('ignores self-loops and out-of-range endpoints', () => {
    const edges = [
      { source: 0, target: 0 },   // self-loop
      { source: 0, target: 9 },   // 9 >= fullNodeCount
      { source: 0, target: 3 }, { source: 1, target: 3 },
    ];
    const proj = buildRetrievedProjection(2, 4, edges, { hubDiscount: 'none' });
    expect(proj.length).toBe(1);
    expect(edge(proj, 0, 1)!.weight).toBe(1);
  });

  it('bridgeWeight links papers connected only through a 2-intermediate chain', () => {
    // 0 → X(3) → Y(4) → 1. No shared neighbour, so one-hop projection finds nothing.
    const edges = [
      { source: 0, target: 3 },
      { source: 3, target: 4 },   // intermediate↔intermediate bridge
      { source: 4, target: 1 },
    ];
    const oneHop = buildRetrievedProjection(2, 5, edges, { hubDiscount: 'none', minWeight: 0 });
    expect(oneHop.length).toBe(0);

    const bridged = buildRetrievedProjection(2, 5, edges, {
      hubDiscount: 'none', minWeight: 0, bridgeWeight: 1,
    });
    expect(edge(bridged, 0, 1)).toBeDefined();
    expect(edge(bridged, 0, 1)!.weight).toBeGreaterThan(0);
  });

  it('bridge contributions accumulate over multiple chains and respect minWeight', () => {
    // Two independent 2-intermediate chains between 0 and 1 → bridge weight adds up.
    const edges = [
      { source: 0, target: 3 }, { source: 3, target: 4 }, { source: 4, target: 1 },
      { source: 0, target: 5 }, { source: 5, target: 6 }, { source: 6, target: 1 },
    ];
    const one = buildRetrievedProjection(2, 7, edges, {
      hubDiscount: 'none', minWeight: 0, bridgeWeight: 1,
    });
    const two = edge(one, 0, 1)!.weight;
    // With bridgeWeight 1 and all bridge intermediates degree 2 (contribution 1
    // under 'none'), each chain adds 1 → two chains sum to 2.
    expect(two).toBe(2);

    // A threshold above a single chain's weight but below the sum keeps the edge.
    const kept = buildRetrievedProjection(2, 7, edges, {
      hubDiscount: 'none', minWeight: 1.5, bridgeWeight: 1,
    });
    expect(edge(kept, 0, 1)).toBeDefined();
  });

  it('does not bridge through a retained paper (only intermediate↔intermediate edges)', () => {
    // 0 → 2(retained) → 1 is NOT a bridge: 2 is a retained paper, so this is just
    // two one-hop co-citations through the shared neighbour 2 (caught one-hop),
    // never a 2-hop intermediate chain.
    const edges = [
      { source: 0, target: 2 }, { source: 2, target: 1 },
    ];
    const bridged = buildRetrievedProjection(3, 5, edges, {
      hubDiscount: 'none', minWeight: 0, bridgeWeight: 1,
    });
    // 0 and 1 share retained neighbour 2 → one-hop edge weight 1 (degree of 2 is 2).
    // No extra bridge weight is added (2 is retained, not an intermediate bridge).
    expect(edge(bridged, 0, 1)!.weight).toBe(1);
  });

  it('returns no edges for a trivial node set', () => {
    expect(buildRetrievedProjection(0, 0, [])).toEqual([]);
    expect(buildRetrievedProjection(1, 3, [{ source: 0, target: 1 }])).toEqual([]);
  });
});
