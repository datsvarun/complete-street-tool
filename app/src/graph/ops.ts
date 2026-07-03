// Pure operations on GraphState. Every function returns a NEW state (shallow-cloned
// records) so the Zustand/Zundo store can treat each call as one undoable step.
import type { DraftVert, GraphState, GraphNode, StreetEdge } from '../types';
import {
  dedupe,
  dist,
  douglasPeucker,
  polylineLength,
  projectOnPolyline,
  segSegIntersection,
  toFlat,
  toPts,
} from '../geometry/polyline';

export const EMPTY_GRAPH: GraphState = { nodes: {}, edges: {}, nextNodeNum: 1, nextEdgeNum: 1 };

function clone(g: GraphState): GraphState {
  return { ...g, nodes: { ...g.nodes }, edges: { ...g.edges } };
}

export function degree(g: GraphState, nodeId: string): number {
  let d = 0;
  for (const e of Object.values(g.edges)) {
    if (e.a === nodeId) d++;
    if (e.b === nodeId) d++;
  }
  return d;
}

export function edgesAt(g: GraphState, nodeId: string): StreetEdge[] {
  return Object.values(g.edges).filter((e) => e.a === nodeId || e.b === nodeId);
}

function addNode(g: GraphState, x: number, y: number): { g: GraphState; id: string } {
  const id = `n${g.nextNodeNum}`;
  g.nodes[id] = { id, x, y };
  g.nextNodeNum += 1;
  return { g, id };
}

function addEdge(g: GraphState, edge: Omit<StreetEdge, 'id'>): { g: GraphState; id: string } {
  const id = `e${g.nextEdgeNum}`;
  g.edges[id] = { ...edge, id };
  g.nextEdgeNum += 1;
  return { g, id };
}

/** Keep an edge's endpoint coordinates in sync with its nodes. */
function syncEndpoints(e: StreetEdge, nodes: Record<string, GraphNode>): StreetEdge {
  const pts = e.points.slice();
  const a = nodes[e.a];
  const b = nodes[e.b];
  if (a) { pts[0] = a.x; pts[1] = a.y; }
  if (b) { pts[pts.length - 2] = b.x; pts[pts.length - 1] = b.y; }
  return { ...e, points: pts };
}

/**
 * Split an edge at the projection of (x, y). Returns the node at the split.
 * If the split lands within tol of an endpoint, reuses that node instead.
 */
export function splitEdge(
  g0: GraphState,
  edgeId: string,
  x: number,
  y: number,
  tol = 0.5,
): { g: GraphState; nodeId: string | null } {
  const g = clone(g0);
  const e = g.edges[edgeId];
  if (!e) return { g: g0, nodeId: null };
  const proj = projectOnPolyline(e.points, x, y);
  if (!proj) return { g: g0, nodeId: null };
  const total = polylineLength(e.points);
  if (proj.station < tol) return { g: g0, nodeId: e.a };
  if (total - proj.station < tol) return { g: g0, nodeId: e.b };

  const { id: nodeId } = addNode(g, proj.x, proj.y);
  const i = proj.segIdx * 2;
  const ptsA = [...e.points.slice(0, i + 2), proj.x, proj.y];
  const ptsB = [proj.x, proj.y, ...e.points.slice(i + 2)];
  const base = { sectionId: e.sectionId, highway: e.highway, name: e.name, oneway: e.oneway,
    carriagewayType: e.carriagewayType, medianWidth: e.medianWidth };
  delete g.edges[edgeId];
  addEdge(g, { ...base, a: e.a, b: nodeId, points: ptsA });
  addEdge(g, { ...base, a: nodeId, b: e.b, points: ptsB });
  return { g, nodeId };
}

/** Move a node; connected edge endpoints follow. */
export function moveNode(g0: GraphState, nodeId: string, x: number, y: number): GraphState {
  const g = clone(g0);
  const n = g.nodes[nodeId];
  if (!n) return g0;
  g.nodes[nodeId] = { ...n, x, y };
  for (const e of Object.values(g.edges)) {
    if (e.a === nodeId || e.b === nodeId) g.edges[e.id] = syncEndpoints(e, g.nodes);
  }
  return g;
}

/** Merge node `drop` into node `keep`: rewires edges, removes collapsed slivers. */
export function mergeNodes(g0: GraphState, keep: string, drop: string): GraphState {
  if (keep === drop || !g0.nodes[keep] || !g0.nodes[drop]) return g0;
  const g = clone(g0);
  for (const e of Object.values(g.edges)) {
    if (e.a !== drop && e.b !== drop) continue;
    const rewired = { ...e, a: e.a === drop ? keep : e.a, b: e.b === drop ? keep : e.b };
    const synced = syncEndpoints(rewired, g.nodes);
    // A self-loop that collapsed to (near) nothing disappears entirely.
    if (synced.a === synced.b && polylineLength(synced.points) < 1) {
      delete g.edges[e.id];
    } else {
      g.edges[e.id] = synced;
    }
  }
  delete g.nodes[drop];
  return g;
}

/** Delete an edge; endpoint nodes that become degree-0 go with it. */
export function deleteEdge(g0: GraphState, edgeId: string): GraphState {
  const g = clone(g0);
  const e = g.edges[edgeId];
  if (!e) return g0;
  delete g.edges[edgeId];
  for (const nid of [e.a, e.b]) {
    if (g.nodes[nid] && degree(g, nid) === 0) delete g.nodes[nid];
  }
  return g;
}

/** Delete a node and every edge touching it (orphan cleanup included). */
export function deleteNode(g0: GraphState, nodeId: string): GraphState {
  let g = clone(g0);
  for (const e of edgesAt(g, nodeId)) g = deleteEdge(g, e.id);
  if (g.nodes[nodeId]) {
    g = clone(g);
    delete g.nodes[nodeId];
  }
  return g;
}

/** Douglas-Peucker on every edge's interior vertices. Returns removed-vertex count. */
export function simplifyEdges(g0: GraphState, tolM: number): { g: GraphState; removed: number } {
  const g = clone(g0);
  let removed = 0;
  for (const e of Object.values(g.edges)) {
    const pts = toPts(e.points);
    const simple = douglasPeucker(pts, tolM);
    if (simple.length < pts.length) {
      removed += pts.length - simple.length;
      g.edges[e.id] = { ...e, points: toFlat(simple) };
    }
  }
  return { g, removed };
}

/**
 * Commit a drawn draft into the graph with planar enforcement (Plan v2 §2.2):
 * - vertices snapped to a node reuse it; snapped to an edge split it (shared node)
 * - crossings with existing edges auto-node both the existing edge and the draft
 * - plain interior vertices stay as geometry
 */
export function commitDraft(
  g0: GraphState,
  draft: DraftVert[],
  tol = 0.5,
): { g: GraphState; created: number } {
  const verts = draft.filter((v, i) => {
    const prev = draft[i - 1];
    return !prev || dist(prev.x, prev.y, v.x, v.y) > tol;
  });
  if (verts.length < 2) return { g: g0, created: 0 };

  let g = clone(g0);

  // 1. Resolve draft vertices that must be nodes: snapped ones, plus both endpoints.
  type ChainVert = { x: number; y: number; nodeId: string | null };
  const chain: ChainVert[] = verts.map((v, i) => {
    const isEnd = i === 0 || i === verts.length - 1;
    if (v.snap?.type === 'node' && g.nodes[v.snap.id]) {
      const n = g.nodes[v.snap.id];
      return { x: n.x, y: n.y, nodeId: n.id };
    }
    if (v.snap?.type === 'edge') {
      const res = g.edges[v.snap.id]
        ? splitEdge(g, v.snap.id, v.x, v.y, tol)
        : { g, nodeId: null };
      if (res.nodeId) {
        g = res.g;
        const n = g.nodes[res.nodeId];
        return { x: n.x, y: n.y, nodeId: n.id };
      }
    }
    if (isEnd) {
      const res = addNode(g, v.x, v.y);
      g = res.g;
      return { x: v.x, y: v.y, nodeId: res.id };
    }
    return { x: v.x, y: v.y, nodeId: null };
  });

  // 2. Planar enforcement: intersect each draft segment with existing edges,
  //    split the existing edge there and insert a noded vertex into the chain.
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    let bestHit: { edgeId: string; x: number; y: number; t: number } | null = null;
    for (const e of Object.values(g.edges)) {
      const pts = e.points;
      for (let j = 0; j + 3 < pts.length; j += 2) {
        const hit = segSegIntersection(a.x, a.y, b.x, b.y, pts[j], pts[j + 1], pts[j + 2], pts[j + 3]);
        if (!hit) continue;
        // Ignore touches at chain nodes (already shared) and near-endpoint grazes.
        if (dist(hit.x, hit.y, a.x, a.y) < tol || dist(hit.x, hit.y, b.x, b.y) < tol) continue;
        if (!bestHit || hit.t < bestHit.t) bestHit = { edgeId: e.id, x: hit.x, y: hit.y, t: hit.t };
      }
    }
    if (bestHit) {
      const res = splitEdge(g, bestHit.edgeId, bestHit.x, bestHit.y, tol);
      if (res.nodeId) {
        g = res.g;
        const n = g.nodes[res.nodeId];
        chain.splice(i + 1, 0, { x: n.x, y: n.y, nodeId: n.id });
        // Re-process from the same vertex: the remainder of this segment may
        // cross more edges (loop continues with the inserted vertex as `b`).
        i -= 1;
      }
    }
  }

  // 3. Emit edges between consecutive noded vertices.
  let created = 0;
  let runStart = 0;
  for (let i = 1; i < chain.length; i++) {
    if (!chain[i].nodeId) continue;
    const span = chain.slice(runStart, i + 1);
    const pts = dedupe(span.map((v) => ({ x: v.x, y: v.y })), 0.01);
    if (pts.length >= 2 && polylineLength(toFlat(pts)) > tol) {
      const res = addEdge(g, {
        a: span[0].nodeId!,
        b: chain[i].nodeId!,
        points: toFlat(pts),
        sectionId: null,
      });
      g = res.g;
      created += 1;
    }
    runStart = i;
  }
  return { g, created };
}
