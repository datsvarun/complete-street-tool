// Network cleanup as ordered, idempotent transforms (osm2streets pattern,
// Case_Study §1.5). Standard pipeline: short → degenerate → short.
import type { GraphState, StreetEdge } from '../types';
import { polylineLength } from '../geometry/polyline';
import { degree, edgesAt, mergeNodes, moveNode } from './ops';

const SHORT_EDGE_M = 8;

/** Collapse internal junction roads: short edges joining two junction nodes. */
export function collapseShortEdges(g0: GraphState): { g: GraphState; collapsed: number } {
  let g = g0;
  let collapsed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of Object.values(g.edges)) {
      if (e.a === e.b) continue;
      if (polylineLength(e.points) >= SHORT_EDGE_M) continue;
      if (degree(g, e.a) < 3 || degree(g, e.b) < 3) continue;
      const na = g.nodes[e.a];
      const nb = g.nodes[e.b];
      g = moveNode(g, e.a, (na.x + nb.x) / 2, (na.y + nb.y) / 2);
      g = mergeNodes(g, e.a, e.b);
      collapsed += 1;
      changed = true;
      break; // restart iteration — the record changed under us
    }
  }
  return { g, collapsed };
}

function canJoin(e1: StreetEdge, e2: StreetEdge, node: string): boolean {
  if (e1.id === e2.id) return false;
  if (e1.highway !== e2.highway) return false;
  if (e1.sectionId !== e2.sectionId) return false;
  if (!!e1.oneway !== !!e2.oneway) return false;
  // Oneway edges may only join head-to-tail (no direction flip).
  if (e1.oneway) {
    const e1Into = e1.b === node;
    const e2Out = e2.a === node;
    return e1Into && e2Out;
  }
  return true;
}

function orient(e: StreetEdge, endAt: string): number[] {
  // points oriented so the polyline ENDS at `endAt`
  if (e.b === endAt) return e.points;
  const pts: number[] = [];
  for (let i = e.points.length - 2; i >= 0; i -= 2) pts.push(e.points[i], e.points[i + 1]);
  return pts;
}

/** Splice out degree-2 nodes where the two edges are compatible. */
export function collapseDegenerateNodes(g0: GraphState): { g: GraphState; collapsed: number } {
  let g = { ...g0, nodes: { ...g0.nodes }, edges: { ...g0.edges } };
  let collapsed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(g.nodes)) {
      const around = edgesAt(g, node.id);
      if (around.length !== 2) continue;
      const [x, y] = around;
      let e1 = x, e2 = y;
      if (!canJoin(e1, e2, node.id)) {
        [e1, e2] = [y, x];
        if (!canJoin(e1, e2, node.id)) continue;
      }
      const p1 = orient(e1, node.id);
      // e2 oriented to START at the node
      const p2fwd: number[] = [];
      if (e2.a === node.id) {
        p2fwd.push(...e2.points);
      } else {
        for (let i = e2.points.length - 2; i >= 0; i -= 2) p2fwd.push(e2.points[i], e2.points[i + 1]);
      }
      const joined: StreetEdge = {
        ...e1,
        a: e1.a === node.id ? e1.b : e1.a,
        b: e2.a === node.id ? e2.b : e2.a,
        points: [...p1, ...p2fwd.slice(2)],
      };
      // Degenerate loops (both edges between the same two nodes) stay as-is.
      if (joined.a === joined.b) continue;
      delete g.edges[e2.id];
      g.edges[e1.id] = joined;
      delete g.nodes[node.id];
      collapsed += 1;
      changed = true;
      break;
    }
  }
  return { g, collapsed };
}

export function runStandardPipeline(g0: GraphState): { g: GraphState; summary: string } {
  const s1 = collapseShortEdges(g0);
  const s2 = collapseDegenerateNodes(s1.g);
  const s3 = collapseShortEdges(s2.g);
  return {
    g: s3.g,
    summary: `${s1.collapsed + s3.collapsed} short edge(s) collapsed, ${s2.collapsed} pass-through node(s) spliced`,
  };
}
