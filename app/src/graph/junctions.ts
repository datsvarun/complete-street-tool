// Derived node artifacts, recomputed from the graph on every change (§1.2):
// - junction polygons at degree-≥3 nodes — osm2streets general case
//   (Case_Study §1.2): clockwise approaches, side-edge collisions,
//   perpendicular projection back onto the centerline for square trims
// - section transitions at degree-2 nodes whose two edges carry different
//   sections — the node itself is the transition point (Sections workflow)
// - per-end edge trims so ribbons stop where these artifacts take over
import type { GraphState, SectionComponent, StreetEdge } from '../types';
import {
  dist,
  offsetPolyline,
  pointAtStation,
  polylineLength,
  projectOnPolyline,
  segSegIntersection,
  subPolyline,
  toFlat,
  toPts,
} from '../geometry/polyline';
import type { RibbonBand } from '../geometry/ribbon';
import {
  matchComponents,
  sampleTransitionBands,
  transitionLength,
} from '../sections/transition';

const FALLBACK_WIDTH_M = 7; // approaches without a section still shape the junction
const MIN_TRIM_M = 1;

export interface JunctionPoly {
  nodeId: string;
  degree: number;
  polygon: number[];
  names: string[];
}

export interface NodeTransition {
  nodeId: string;
  bands: RibbonBand[];
}

export interface EdgeTrim {
  start: number; // metres cut from the a-end
  end: number;   // metres cut from the b-end
}

export interface NodeArtifacts {
  junctions: JunctionPoly[];
  transitions: NodeTransition[];
  trims: Record<string, EdgeTrim>;
}

function edgeWidth(e: StreetEdge): number {
  const total = e.section?.components.reduce((s, c) => s + c.widthM, 0);
  return total && total > 0.5 ? total : FALLBACK_WIDTH_M;
}

/** Edge points oriented to START at the given node. */
function pointsAwayFrom(e: StreetEdge, nodeId: string): number[] {
  if (e.a === nodeId) return e.points;
  const out: number[] = [];
  for (let i = e.points.length - 2; i >= 0; i -= 2) out.push(e.points[i], e.points[i + 1]);
  return out;
}

/** Section components in travel order along `pts` orientation vs the edge's own. */
function orientedComponents(e: StreetEdge, reversed: boolean): SectionComponent[] {
  const comps = e.section?.components ?? [];
  return reversed ? [...comps].reverse() : comps;
}

function offsetSide(pts: number[], d: number): number[] {
  return toFlat(offsetPolyline(toPts(pts), d));
}

/** First intersection of two polylines, scanning outward along `a`. */
function firstHit(a: number[], b: number[]): { x: number; y: number } | null {
  for (let i = 0; i + 3 < a.length; i += 2) {
    for (let j = 0; j + 3 < b.length; j += 2) {
      const hit = segSegIntersection(
        a[i], a[i + 1], a[i + 2], a[i + 3],
        b[j], b[j + 1], b[j + 2], b[j + 3],
      );
      if (hit) return { x: hit.x, y: hit.y };
    }
  }
  return null;
}

/** Intersection of the infinite lines through the first segments of a and b. */
function firstSegLineHit(a: number[], b: number[]): { x: number; y: number } | null {
  const d1x = a[2] - a[0], d1y = a[3] - a[1];
  const d2x = b[2] - b[0], d2y = b[3] - b[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / denom;
  return { x: a[0] + t * d1x, y: a[1] + t * d1y };
}

interface Approach {
  edge: StreetEdge;
  away: number[];    // centerline starting at the node
  len: number;
  hw: number;
  left: number[];    // side polylines in away-orientation
  right: number[];
  angle: number;
}

function junctionForNode(nodeId: string, edges: StreetEdge[]): {
  poly: JunctionPoly;
  trims: Array<{ edgeId: string; end: 'start' | 'end'; trim: number }>;
} | null {
  const approaches: Approach[] = edges.map((e) => {
    const away = pointsAwayFrom(e, nodeId);
    const hw = Math.max(edgeWidth(e) / 2, 1);
    return {
      edge: e,
      away,
      len: polylineLength(away),
      hw,
      left: offsetSide(away, hw),
      right: offsetSide(away, -hw),
      angle: Math.atan2(away[3] - away[1], away[2] - away[0]),
    };
  });
  approaches.sort((p, q) => p.angle - q.angle); // ascending atan2 = clockwise in y-down

  const k = approaches.length;
  // Corner between consecutive approaches: right side of i meets left side of i+1.
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < k; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % k];
    const hit =
      firstHit(a.right, b.left) ??
      firstSegLineHit(a.right, b.left) ?? {
        x: (a.right[0] + b.left[0]) / 2,
        y: (a.right[1] + b.left[1]) / 2,
      };
    corners.push(hit);
  }

  // Trim each approach to its two corners, projected PERPENDICULARLY onto the
  // centerline — the key osm2streets insight: cuts stay square to the road.
  const trims: number[] = approaches.map((a, i) => {
    const cPrev = corners[(i - 1 + k) % k]; // on a's left side
    const cNext = corners[i];               // on a's right side
    let t = MIN_TRIM_M;
    for (const c of [cPrev, cNext]) {
      const proj = projectOnPolyline(a.away, c.x, c.y);
      if (proj) t = Math.max(t, proj.station);
    }
    return Math.min(t, a.len * 0.45);
  });

  // Polygon: walk clockwise — left cap point, right cap point, corner to next.
  const ring: number[] = [];
  approaches.forEach((a, i) => {
    const p = pointAtStation(a.away, trims[i]);
    ring.push(p.x + p.nx * a.hw, p.y + p.ny * a.hw);   // left of away = boundary entry
    ring.push(p.x - p.nx * a.hw, p.y - p.ny * a.hw);   // right of away
    ring.push(corners[i].x, corners[i].y);
  });

  const names = [...new Set(approaches.map((a) => a.edge.name).filter(Boolean))] as string[];
  return {
    poly: { nodeId, degree: k, polygon: ring, names },
    trims: approaches.map((a, i) => ({
      edgeId: a.edge.id,
      end: a.edge.a === nodeId ? 'start' : 'end',
      trim: trims[i],
    })),
  };
}

function sectionsDiffer(c1: SectionComponent[], c2: SectionComponent[]): boolean {
  if (c1.length !== c2.length) return true;
  return c1.some((c, i) => c.kind !== c2[i].kind || Math.abs(c.widthM - c2[i].widthM) > 0.01);
}

function transitionForNode(
  nodeId: string,
  eIn: StreetEdge,
  eOut: StreetEdge,
): {
  bands: RibbonBand[];
  trims: Array<{ edgeId: string; end: 'start' | 'end'; trim: number }>;
} | null {
  if (!eIn.section || !eOut.section) return null;
  // Orient: eIn traversed TOWARD the node, eOut AWAY — components follow travel direction.
  const inReversed = eIn.b !== nodeId;
  const outReversed = eOut.a !== nodeId;
  const compsIn = orientedComponents(eIn, inReversed);
  const compsOut = orientedComponents(eOut, outReversed);
  if (!sectionsDiffer(compsIn, compsOut)) return null;

  // Incoming edge oriented to END at the node: reverse its away-from-node pairs.
  const awayIn = pointsAwayFrom(eIn, nodeId);
  const towardIn: number[] = [];
  for (let i = awayIn.length - 2; i >= 0; i -= 2) towardIn.push(awayIn[i], awayIn[i + 1]);
  const awayOut = pointsAwayFrom(eOut, nodeId);

  const lenIn = polylineLength(towardIn);
  const lenOut = polylineLength(awayOut);
  const matched = matchComponents(compsIn, compsOut);
  const Lt = transitionLength(matched, Math.min(lenIn, lenOut) * 0.9);
  const half = Lt / 2;
  const tIn = Math.min(half, lenIn * 0.45);
  const tOut = Math.min(half, lenOut * 0.45);

  // Combined path across the node: tail of the incoming edge + head of the outgoing.
  const partA = subPolyline(towardIn, lenIn - tIn, lenIn);
  const partB = subPolyline(awayOut, 0, tOut);
  const path = [...partA];
  // skip duplicated node point
  const startJ = dist(partB[0], partB[1], partA[partA.length - 2], partA[partA.length - 1]) < 0.05 ? 2 : 0;
  for (let i = startJ; i < partB.length; i++) path.push(partB[i]);
  if (path.length < 4) return null;

  const bands = sampleTransitionBands(path, matched, 0, polylineLength(path), `nt-${nodeId}`);
  return {
    bands,
    trims: [
      { edgeId: eIn.id, end: eIn.b === nodeId ? 'end' : 'start', trim: tIn },
      { edgeId: eOut.id, end: eOut.a === nodeId ? 'start' : 'end', trim: tOut },
    ],
  };
}

/** One pass over all nodes → junction polygons, node transitions, edge trims. */
export function deriveNodeArtifacts(g: GraphState): NodeArtifacts {
  const byNode = new Map<string, StreetEdge[]>();
  for (const e of Object.values(g.edges)) {
    for (const nid of [e.a, e.b]) {
      const list = byNode.get(nid) ?? [];
      list.push(e);
      byNode.set(nid, list);
    }
  }

  const junctions: JunctionPoly[] = [];
  const transitions: NodeTransition[] = [];
  const trims: Record<string, EdgeTrim> = {};
  const addTrim = (edgeId: string, end: 'start' | 'end', trim: number) => {
    const t = trims[edgeId] ?? { start: 0, end: 0 };
    t[end] = Math.max(t[end], trim);
    trims[edgeId] = t;
  };

  for (const [nodeId, edges] of byNode) {
    if (!g.nodes[nodeId]) continue;
    if (edges.length >= 3) {
      const res = junctionForNode(nodeId, edges);
      if (res) {
        junctions.push(res.poly);
        res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
      }
    } else if (edges.length === 2 && edges[0].id !== edges[1].id) {
      const res = transitionForNode(nodeId, edges[0], edges[1]);
      if (res) {
        transitions.push({ nodeId, bands: res.bands });
        res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
      }
    }
  }
  return { junctions, transitions, trims };
}
