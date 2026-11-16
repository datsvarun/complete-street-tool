import { describe, expect, it } from 'vitest';
import type { GraphState, StreetEdge } from '../types';
import { commitDraft, degree, EMPTY_GRAPH, graphBounds, joinThroughNode, splitEdge } from './ops';

function graphWith(edges: Array<Partial<StreetEdge> & { id: string; a: string; b: string; points: number[] }>): GraphState {
  const g: GraphState = { ...EMPTY_GRAPH, nodes: {}, edges: {}, nextNodeNum: 1, nextEdgeNum: 1 };
  for (const e of edges) {
    g.edges[e.id] = { section: null, ...e } as StreetEdge;
    for (const [nid, i] of [[e.a, 0], [e.b, e.points.length - 2]] as Array<[string, number]>) {
      g.nodes[nid] = { id: nid, x: e.points[i], y: e.points[i + 1] };
    }
    g.nextEdgeNum = Math.max(g.nextEdgeNum, parseInt(e.id.slice(1), 10) + 1);
  }
  g.nextNodeNum = Object.keys(g.nodes).length + 1;
  return g;
}

describe('commitDraft', () => {
  it('creates one edge with endpoint nodes from a plain draft', () => {
    const { g, created } = commitDraft(EMPTY_GRAPH, [
      { x: 0, y: 0, snap: null },
      { x: 50, y: 0, snap: null },
    ]);
    expect(created).toBe(1);
    expect(Object.keys(g.edges)).toHaveLength(1);
    expect(Object.keys(g.nodes)).toHaveLength(2);
  });

  it('auto-nodes crossings with existing edges (planar enforcement)', () => {
    const g0 = graphWith([{ id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 100, 0] }]);
    const { g } = commitDraft(g0, [
      { x: 50, y: -30, snap: null },
      { x: 50, y: 30, snap: null },
    ]);
    // existing edge split in two + draft split in two at the shared node
    expect(Object.keys(g.edges)).toHaveLength(4);
    const crossing = Object.values(g.nodes).find((n) => Math.abs(n.x - 50) < 0.6 && Math.abs(n.y) < 0.6);
    expect(crossing).toBeDefined();
    expect(degree(g, crossing!.id)).toBe(4);
  });

  it('re-resolves a snap to an edge the same draft already split (regression)', () => {
    // Draft starts on e1 and ends on e1: the first snap splits e1 away, so the
    // second snap's edge id is stale. It must re-resolve, not leave a
    // disconnected node sitting on the street.
    const g0 = graphWith([{ id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 100, 0] }]);
    const { g } = commitDraft(g0, [
      { x: 30, y: 0, snap: { type: 'edge', id: 'e1', x: 30, y: 0 } },
      { x: 50, y: 40, snap: null },
      { x: 70, y: 0, snap: { type: 'edge', id: 'e1', x: 70, y: 0 } },
    ]);
    // original street in 3 parts + the draft (its bend stays interior geometry)
    expect(Object.keys(g.edges)).toHaveLength(4);
    const end = Object.values(g.nodes).find((n) => Math.abs(n.x - 70) < 0.6 && Math.abs(n.y) < 0.6);
    expect(end).toBeDefined();
    // connected: the street continues through it AND the draft arrives
    expect(degree(g, end!.id)).toBe(3);
  });
});

describe('joinThroughNode', () => {
  it('refuses to heal through a node carrying a self-loop (regression)', () => {
    const g = graphWith([
      { id: 'e1', a: 'n1', b: 'n1', points: [0, 0, 10, 5, 10, -5, 0, 0] },
      { id: 'e2', a: 'n1', b: 'n2', points: [0, 0, 40, 0] },
    ]);
    expect(joinThroughNode(g, 'n1')).toBeNull();
  });

  it('reports reversal metadata for element re-anchoring', () => {
    const g = graphWith([
      { id: 'e1', a: 'n2', b: 'nMid', points: [50, 0, 100, 0] },
      { id: 'e2', a: 'nMid', b: 'n3', points: [100, 0, 150, 0] },
    ]);
    const res = joinThroughNode(g, 'nMid');
    expect(res).not.toBeNull();
    expect(res!.keptId).toBe('e1');
    expect(res!.e1Reversed).toBe(false);
    expect(res!.len1).toBeCloseTo(50);
    expect(res!.g.edges.e1.points).toHaveLength(6);
  });
});

describe('splitEdge', () => {
  it('splits into two halves sharing a new node', () => {
    const g0 = graphWith([{ id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 100, 0] }]);
    const { g, nodeId } = splitEdge(g0, 'e1', 40, 3);
    expect(nodeId).toBeTruthy();
    expect(Object.keys(g.edges)).toHaveLength(2);
    expect(g.edges.e1).toBeUndefined();
  });
});

describe('graphBounds', () => {
  it('covers edge interior vertices, not just nodes', () => {
    const g = graphWith([{ id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 50, 80, 100, 0] }]);
    const b = graphBounds(g)!;
    expect(b.maxY).toBe(80);
  });
});
