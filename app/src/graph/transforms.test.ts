import { describe, expect, it } from 'vitest';
import type { GraphState, StreetEdge } from '../types';
import { collapseShortEdges, collapseDegenerateNodes } from './transforms';
import { mergeDualCarriageway } from './dualCarriageway';
import { EMPTY_GRAPH } from './ops';

function graphWith(edges: Array<Partial<StreetEdge> & { id: string; a: string; b: string; points: number[] }>): GraphState {
  const g: GraphState = { ...EMPTY_GRAPH, nodes: {}, edges: {}, nextNodeNum: 99, nextEdgeNum: 99 };
  for (const e of edges) {
    g.edges[e.id] = { section: null, ...e } as StreetEdge;
    for (const [nid, i] of [[e.a, 0], [e.b, e.points.length - 2]] as Array<[string, number]>) {
      g.nodes[nid] = { id: nid, x: e.points[i], y: e.points[i + 1] };
    }
  }
  return g;
}

describe('collapseShortEdges', () => {
  it('never leaves self-loop edges behind (regression)', () => {
    // Curved 7 m link between two junction nodes — the old code relied on
    // mergeNodes' 1 m sliver heuristic and kept it as a permanent self-loop.
    const g0 = graphWith([
      { id: 'eShort', a: 'n1', b: 'n2', points: [0, 0, 3, 2, 6, 0] },
      { id: 'a1', a: 'n1', b: 'x1', points: [0, 0, -20, 0] },
      { id: 'a2', a: 'n1', b: 'x2', points: [0, 0, 0, -20] },
      { id: 'b1', a: 'n2', b: 'x3', points: [6, 0, 26, 0] },
      { id: 'b2', a: 'n2', b: 'x4', points: [6, 0, 6, 20] },
    ]);
    const { g, collapsed } = collapseShortEdges(g0);
    expect(collapsed).toBe(1);
    expect(g.edges.eShort).toBeUndefined();
    expect(Object.values(g.edges).some((e) => e.a === e.b)).toBe(false);
  });
});

describe('collapseDegenerateNodes', () => {
  it('does not splice a divided edge with an undivided one', () => {
    const g0 = graphWith([
      { id: 'e1', a: 'n1', b: 'nMid', points: [0, 0, 50, 0], carriagewayType: 'divided' },
      { id: 'e2', a: 'nMid', b: 'n2', points: [50, 0, 100, 0] },
    ]);
    const { collapsed } = collapseDegenerateNodes(g0);
    expect(collapsed).toBe(0);
  });

  it('skips nodes carrying a self-loop (regression)', () => {
    const g0 = graphWith([
      { id: 'loop', a: 'n1', b: 'n1', points: [0, 0, 10, 5, 10, -5, 0, 0] },
      { id: 'e2', a: 'n1', b: 'n2', points: [0, 0, 40, 0] },
    ]);
    const { g } = collapseDegenerateNodes(g0);
    for (const e of Object.values(g.edges)) {
      expect(g.nodes[e.a]).toBeDefined();
      expect(g.nodes[e.b]).toBeDefined();
    }
  });
});

describe('mergeDualCarriageway', () => {
  it('bails when the pair shares an endpoint (regression)', () => {
    const g0 = graphWith([
      { id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 100, 0], oneway: true },
      { id: 'e2', a: 'n2', b: 'n3', points: [100, 0, 200, 0], oneway: true },
    ]);
    const g = mergeDualCarriageway(g0, { e1: 'e1', e2: 'e2', meanSepM: 10 });
    // unchanged: every edge endpoint still resolves to a live node
    for (const e of Object.values(g.edges)) {
      expect(g.nodes[e.a]).toBeDefined();
      expect(g.nodes[e.b]).toBeDefined();
    }
    expect(Object.keys(g.edges)).toHaveLength(2);
  });
});
