// Derived node artifacts, recomputed from the graph on every change (§1.2):
// - junction polygons — osm2streets corner method (Case_Study §1.2) generalized
//   to CLUSTERS: junctions whose polygons would collide on a shared edge merge
//   into one complex junction; the shared edges become junction surface
// - corner fillets: curb-side corners rounded with a class-independent radius,
//   and corner distance clamped so shallow-angle approaches can't spike
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
  ribbonBand,
} from '../geometry/polyline';
import type { RibbonBand } from '../geometry/ribbon';
import { alignFactor } from '../geometry/ribbon';
import {
  matchComponents,
  sampleTransitionBands,
  transitionLength,
} from '../sections/transition';

const FALLBACK_WIDTH_M = 7; // approaches without a section still shape the junction
const MIN_TRIM_M = 1;
const FILLET_R_M = 6;       // curb corner radius (parametric per-junction later)
const MERGE_FRACTION = 0.75; // trims consuming this much of an edge merge its junctions

export interface JunctionPoly {
  nodeIds: string[];
  degree: number;      // number of approaches
  polygon: number[];
  coverBands: number[][]; // internal consumed edges, filled as junction surface
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
  node: string;      // the cluster node this approach leaves from
  away: number[];
  len: number;
  hw: number;
  left: number[];
  right: number[];
  angle: number;
}

interface ClusterResult {
  poly: JunctionPoly;
  trims: Array<{ edgeId: string; end: 'start' | 'end'; trim: number }>;
}

/** Rounded corner: replace C between prev→C→next with a sampled quadratic arc. */
function filletCorner(prev: { x: number; y: number }, C: { x: number; y: number }, next: { x: number; y: number }): number[] {
  const dPrev = dist(C.x, C.y, prev.x, prev.y);
  const dNext = dist(C.x, C.y, next.x, next.y);
  const r = Math.min(FILLET_R_M, dPrev * 0.6, dNext * 0.6);
  if (r < 0.4) return [C.x, C.y];
  const p1 = { x: C.x + ((prev.x - C.x) / dPrev) * r, y: C.y + ((prev.y - C.y) / dPrev) * r };
  const p2 = { x: C.x + ((next.x - C.x) / dNext) * r, y: C.y + ((next.y - C.y) / dNext) * r };
  const out: number[] = [];
  const N = 6;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const a = 1 - t;
    out.push(
      a * a * p1.x + 2 * a * t * C.x + t * t * p2.x,
      a * a * p1.y + 2 * a * t * C.y + t * t * p2.y,
    );
  }
  return out;
}

/**
 * Junction polygon for a cluster of one or more nodes: approaches sorted
 * clockwise, right-side × left-side collisions per adjacent pair, corners
 * projected perpendicularly onto centerlines for square trims, corner
 * distance clamped (no shallow-angle spikes), curb corners filleted.
 */
function computeJunction(g: GraphState, nodeIds: string[], edges: StreetEdge[]): ClusterResult | null {
  const inCluster = new Set(nodeIds);
  const approachesRaw: Array<{ edge: StreetEdge; node: string }> = [];
  const internal: StreetEdge[] = [];
  for (const e of edges) {
    const aIn = inCluster.has(e.a);
    const bIn = inCluster.has(e.b);
    if (aIn && bIn) internal.push(e);
    else if (aIn) approachesRaw.push({ edge: e, node: e.a });
    else if (bIn) approachesRaw.push({ edge: e, node: e.b });
  }
  if (approachesRaw.length < 3) return null;

  const cx = nodeIds.reduce((s, id) => s + g.nodes[id].x, 0) / nodeIds.length;
  const cy = nodeIds.reduce((s, id) => s + g.nodes[id].y, 0) / nodeIds.length;
  const clusterR = Math.max(...nodeIds.map((id) => dist(g.nodes[id].x, g.nodes[id].y, cx, cy)), 0);

  const approaches: Approach[] = approachesRaw.map(({ edge, node }) => {
    const away = pointsAwayFrom(edge, node);
    const hw = Math.max(edgeWidth(edge) / 2, 1);
    const len = polylineLength(away);
    const probe = pointAtStation(away, Math.min(6, len * 0.5));
    return {
      edge, node, away, len, hw,
      left: offsetSide(away, hw),
      right: offsetSide(away, -hw),
      angle: Math.atan2(probe.y - cy, probe.x - cx),
    };
  });
  approaches.sort((p, q) => p.angle - q.angle); // ascending atan2 = clockwise, y-down

  const maxHw = Math.max(...approaches.map((a) => a.hw));
  const cornerClamp = clusterR + maxHw * 3 + 4;

  const k = approaches.length;
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < k; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % k];
    let hit =
      firstHit(a.right, b.left) ??
      firstSegLineHit(a.right, b.left) ?? {
        x: (a.right[0] + b.left[0]) / 2,
        y: (a.right[1] + b.left[1]) / 2,
      };
    // Clamp runaway corners from near-parallel side pairs (the "spike" case).
    const d = dist(hit.x, hit.y, cx, cy);
    if (d > cornerClamp) {
      hit = { x: cx + ((hit.x - cx) / d) * cornerClamp, y: cy + ((hit.y - cy) / d) * cornerClamp };
    }
    corners.push(hit);
  }

  const trims: number[] = approaches.map((a, i) => {
    const cPrev = corners[(i - 1 + k) % k];
    const cNext = corners[i];
    let t = MIN_TRIM_M;
    for (const c of [cPrev, cNext]) {
      const proj = projectOnPolyline(a.away, c.x, c.y);
      if (proj) t = Math.max(t, proj.station);
    }
    return Math.min(t, a.len * 0.45);
  });

  // Ring with filleted curb corners: left cap, right cap, fillet(corner).
  const ring: number[] = [];
  approaches.forEach((a, i) => {
    const p = pointAtStation(a.away, trims[i]);
    const pl = { x: p.x + p.nx * a.hw, y: p.y + p.ny * a.hw };
    const pr = { x: p.x - p.nx * a.hw, y: p.y - p.ny * a.hw };
    const next = approaches[(i + 1) % k];
    const pNext = pointAtStation(next.away, trims[(i + 1) % k]);
    const plNext = { x: pNext.x + pNext.nx * next.hw, y: pNext.y + pNext.ny * next.hw };
    ring.push(pl.x, pl.y, pr.x, pr.y);
    ring.push(...filletCorner(pr, corners[i], plNext));
  });

  // Internal edges become junction surface: full-width cover bands.
  const coverBands = internal.map((e) =>
    ribbonBand(toPts(e.points), edgeWidth(e) / 2, -edgeWidth(e) / 2),
  );

  return {
    poly: {
      nodeIds,
      degree: k,
      polygon: ring,
      coverBands,
      names: [...new Set(approaches.map((a) => a.edge.name).filter(Boolean))] as string[],
    },
    trims: [
      ...approaches.map((a, i) => ({
        edgeId: a.edge.id,
        end: (a.edge.a === a.node ? 'start' : 'end') as 'start' | 'end',
        trim: trims[i],
      })),
      // Internal edges render nothing — the junction owns their full length.
      ...internal.flatMap((e) => {
        const L = polylineLength(e.points);
        return [
          { edgeId: e.id, end: 'start' as const, trim: L },
          { edgeId: e.id, end: 'end' as const, trim: L },
        ];
      }),
    ],
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

  const partA = subPolyline(towardIn, lenIn - tIn, lenIn);
  const partB = subPolyline(awayOut, 0, tOut);
  const path = [...partA];
  const startJ = dist(partB[0], partB[1], partA[partA.length - 2], partA[partA.length - 1]) < 0.05 ? 2 : 0;
  for (let i = startJ; i < partB.length; i++) path.push(partB[i]);
  if (path.length < 4) return null;

  // Alignment factors follow travel orientation (reversal mirrors left/right).
  let fIn = alignFactor(eIn.section.align);
  let fOut = alignFactor(eOut.section.align);
  if (inReversed) fIn = 1 - fIn;
  if (outReversed) fOut = 1 - fOut;

  const bands = sampleTransitionBands(path, matched, 0, polylineLength(path), `nt-${nodeId}`, fIn, fOut);
  return {
    bands,
    trims: [
      { edgeId: eIn.id, end: eIn.b === nodeId ? 'end' : 'start', trim: tIn },
      { edgeId: eOut.id, end: eOut.a === nodeId ? 'start' : 'end', trim: tOut },
    ],
  };
}

/** One pass over all nodes → junction polygons (merged where colliding), node transitions, edge trims. */
export function deriveNodeArtifacts(g: GraphState): NodeArtifacts {
  const byNode = new Map<string, StreetEdge[]>();
  for (const e of Object.values(g.edges)) {
    for (const nid of [e.a, e.b]) {
      if (!g.nodes[nid]) continue;
      const list = byNode.get(nid) ?? [];
      list.push(e);
      byNode.set(nid, list);
    }
  }

  const junctionNodes = [...byNode.entries()].filter(([, es]) => es.length >= 3).map(([id]) => id);
  const isJunction = new Set(junctionNodes);

  // Pass 1: singleton trims decide which shared edges are consumed.
  const singleTrim = new Map<string, number>(); // `${edgeId}:${end}` → trim
  for (const nid of junctionNodes) {
    const res = computeJunction(g, [nid], byNode.get(nid)!);
    res?.trims.forEach((t) => singleTrim.set(`${t.edgeId}:${t.end}`, t.trim));
  }

  // Union-find over junction nodes joined by consumed edges.
  const parent = new Map<string, string>(junctionNodes.map((n) => [n, n]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of Object.values(g.edges)) {
    if (!isJunction.has(e.a) || !isJunction.has(e.b) || e.a === e.b) continue;
    const L = polylineLength(e.points);
    const tSum = (singleTrim.get(`${e.id}:start`) ?? 0) + (singleTrim.get(`${e.id}:end`) ?? 0);
    if (tSum >= L * MERGE_FRACTION) parent.set(find(e.a), find(e.b));
  }
  const clusters = new Map<string, string[]>();
  for (const nid of junctionNodes) {
    const root = find(nid);
    clusters.set(root, [...(clusters.get(root) ?? []), nid]);
  }

  const junctions: JunctionPoly[] = [];
  const transitions: NodeTransition[] = [];
  const trims: Record<string, EdgeTrim> = {};
  const addTrim = (edgeId: string, end: 'start' | 'end', trim: number) => {
    const t = trims[edgeId] ?? { start: 0, end: 0 };
    t[end] = Math.max(t[end], trim);
    trims[edgeId] = t;
  };

  // Pass 2: one junction per cluster.
  for (const nodeIds of clusters.values()) {
    const edgeSet = new Map<string, StreetEdge>();
    for (const nid of nodeIds) for (const e of byNode.get(nid)!) edgeSet.set(e.id, e);
    const res = computeJunction(g, nodeIds, [...edgeSet.values()]);
    if (res) {
      junctions.push(res.poly);
      res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
    }
  }

  // Degree-2 nodes: section transitions.
  for (const [nodeId, edges] of byNode) {
    if (edges.length === 2 && edges[0].id !== edges[1].id) {
      const res = transitionForNode(nodeId, edges[0], edges[1]);
      if (res) {
        transitions.push({ nodeId, bands: res.bands });
        res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
      }
    }
  }
  return { junctions, transitions, trims };
}
