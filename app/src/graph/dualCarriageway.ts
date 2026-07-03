// Assisted dual-carriageway merge (Plan v2 §0.3, §2.3): detect parallel one-way
// pairs, and on user confirmation synthesize a midline single edge. Automatic
// merging is explicitly out of scope — the user confirms each pair.
import type { DcCandidate, GraphState } from '../types';
import {
  bearing,
  bearingDiff,
  dist,
  polylineLength,
  projectOnPolyline,
  resample,
  toFlat,
} from '../geometry/polyline';
import { deleteEdge, mergeNodes, moveNode } from './ops';

const MAX_SEP_M = 30;
const MAX_MEAN_SEP_M = 25;
const MAX_BEARING_DELTA = 20; // from anti-parallel (180°)
const MIN_LEN_M = 30;
const MAX_END_GAP_M = 45;

function meanSeparation(a: number[], b: number[]): number | null {
  const samples = resample(a, 10);
  let sum = 0;
  for (const p of samples) {
    const proj = projectOnPolyline(b, p.x, p.y);
    if (!proj || proj.dist > MAX_SEP_M) return null;
    sum += proj.dist;
  }
  return sum / samples.length;
}

export function detectDualCarriageways(g: GraphState): DcCandidate[] {
  const edges = Object.values(g.edges).filter(
    (e) => e.oneway && e.carriagewayType !== 'divided' && polylineLength(e.points) >= MIN_LEN_M,
  );
  const out: DcCandidate[] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      // Anti-parallel bearings within tolerance
      const d = bearingDiff(bearing(e1.points), bearing(e2.points));
      if (Math.abs(d - 180) > MAX_BEARING_DELTA) continue;
      // Ends pair up crosswise (start of one near end of the other)
      const p1 = e1.points;
      const p2 = e2.points;
      const gapA = dist(p1[0], p1[1], p2[p2.length - 2], p2[p2.length - 1]);
      const gapB = dist(p1[p1.length - 2], p1[p1.length - 1], p2[0], p2[1]);
      if (gapA > MAX_END_GAP_M || gapB > MAX_END_GAP_M) continue;
      // Mutually close along their length
      const sep1 = meanSeparation(e1.points, e2.points);
      if (sep1 === null || sep1 > MAX_MEAN_SEP_M) continue;
      const sep2 = meanSeparation(e2.points, e1.points);
      if (sep2 === null || sep2 > MAX_MEAN_SEP_M) continue;
      out.push({
        e1: e1.id,
        e2: e2.id,
        meanSepM: (sep1 + sep2) / 2,
        name: e1.name ?? e2.name,
      });
    }
  }
  return out.sort((a, b) => a.meanSepM - b.meanSepM);
}

/** Merge a confirmed pair into one divided-carriageway edge on a synthesized midline. */
export function mergeDualCarriageway(g0: GraphState, c: DcCandidate): GraphState {
  const e1 = g0.edges[c.e1];
  const e2 = g0.edges[c.e2];
  if (!e1 || !e2) return g0;

  // Midline: average of the two polylines after arc-length reparameterization,
  // with e2 reversed so both run the same way.
  const n = Math.max(8, Math.round(polylineLength(e1.points) / 5));
  const s1 = resample(e1.points, n);
  const rev2: number[] = [];
  for (let i = e2.points.length - 2; i >= 0; i -= 2) rev2.push(e2.points[i], e2.points[i + 1]);
  const s2 = resample(rev2, n);
  const mid = s1.map((p, i) => ({ x: (p.x + s2[i].x) / 2, y: (p.y + s2[i].y) / 2 }));

  const aKeep = e1.a; // pairs with e2.b across the median
  const bKeep = e1.b; // pairs with e2.a
  const aDrop = e2.b;
  const bDrop = e2.a;

  let g = deleteEdge(g0, e1.id);
  g = deleteEdge(g, e2.id);
  // deleteEdge may have removed now-orphaned endpoints; make sure ours survive/merge.
  const ensure = (id: string, x: number, y: number) => {
    if (!g.nodes[id]) {
      g = { ...g, nodes: { ...g.nodes, [id]: { id, x, y } } };
    }
  };
  ensure(aKeep, mid[0].x, mid[0].y);
  ensure(bKeep, mid[mid.length - 1].x, mid[mid.length - 1].y);
  g = moveNode(g, aKeep, mid[0].x, mid[0].y);
  g = moveNode(g, bKeep, mid[mid.length - 1].x, mid[mid.length - 1].y);
  if (aDrop !== aKeep && g.nodes[aDrop]) g = mergeNodes(g, aKeep, aDrop);
  if (bDrop !== bKeep && g.nodes[bDrop]) g = mergeNodes(g, bKeep, bDrop);

  const id = `e${g.nextEdgeNum}`;
  g = {
    ...g,
    nextEdgeNum: g.nextEdgeNum + 1,
    edges: {
      ...g.edges,
      [id]: {
        id,
        a: aKeep,
        b: bKeep,
        points: toFlat(mid),
        sectionId: e1.sectionId ?? e2.sectionId,
        highway: e1.highway,
        name: e1.name ?? e2.name,
        oneway: false,
        carriagewayType: 'divided',
        // Rough estimate until sections exist: separation minus one carriageway
        // (~7m two-lane) — refined in Stage 2 (Plan v2 §2.3).
        medianWidth: Math.max(0.5, Math.round((c.meanSepM - 7) * 10) / 10),
      },
    },
  };
  return g;
}
