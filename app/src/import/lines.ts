// Shared back end of the file importers (GeoJSON, DXF): plain polylines in
// local metres are added to the graph through the same planar commit the Draw
// tool uses, so imported lines node at crossings and share endpoints.
import type { DraftVert, GraphState } from '../types';
import { commitDraft } from '../graph/ops';

export interface ImportLine {
  points: number[]; // flat [x0, y0, ...], local metres (y down)
  name?: string;
  highway?: string;
}

const JOIN_TOL = 0.5; // endpoints closer than this share a node

/** Add `lines` to `g0`. Line ends landing on an existing node reuse it. */
export function addLinesToGraph(g0: GraphState, lines: ImportLine[]): { g: GraphState; added: number } {
  let g = g0;
  let added = 0;
  for (const line of lines) {
    const n = line.points.length / 2;
    if (n < 2) continue;
    const draft: DraftVert[] = [];
    for (let i = 0; i < n; i++) {
      const x = line.points[i * 2];
      const y = line.points[i * 2 + 1];
      let snap: DraftVert['snap'] = null;
      if (i === 0 || i === n - 1) {
        for (const node of Object.values(g.nodes)) {
          if (Math.hypot(node.x - x, node.y - y) < JOIN_TOL) {
            snap = { type: 'node', id: node.id, x: node.x, y: node.y };
            break;
          }
        }
      }
      draft.push({ x, y, snap });
    }
    const before = new Set(Object.keys(g.edges));
    const res = commitDraft(g, draft, 0.05);
    if (res.created === 0) continue;
    g = res.g;
    added += res.created;
    if (line.name || line.highway) {
      const edges = { ...g.edges };
      for (const id of Object.keys(edges)) {
        if (!before.has(id) && !edges[id].name && !edges[id].highway) {
          edges[id] = { ...edges[id], name: line.name, highway: line.highway };
        }
      }
      g = { ...g, edges };
    }
  }
  return { g, added };
}
