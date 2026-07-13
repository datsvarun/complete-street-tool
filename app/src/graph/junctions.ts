// Derived node artifacts, recomputed from the graph on every change (§1.2).
// Junction geometry per Junction_Tool_Design.md slices J1+J2:
// - curb-line corner solver: tangent arcs of a real turning radius R between
//   the curb lines of adjacent approaches; R from a citable class table,
//   shrunk to fit short frontages; tangent stations become the ribbon trims
// - corner wedges: the raised stacks (footpath/cycle/buffer…) of adjacent
//   approaches bridge seamlessly around the arc — the transition engine's
//   matcher/sampler running on the corner path instead of a centerline
// - median noses: divided approaches end in a rounded cap at the mouth
// - clusters: colliding junctions merge (union-find) into one complex junction
// - degree-2 section transitions: the node is the transition point
import type {
  CornerOverride,
  GraphState,
  JunctionDesign,
  SectionComponent,
  StreetEdge,
} from '../types';
import {
  dedupe as dedupePts,
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
import { refFraction } from '../geometry/ribbon';
import {
  matchComponents,
  sampleTransitionBands,
  transitionLength,
} from '../sections/transition';
import { DRIVABLE_KINDS } from '../catalog';

const FALLBACK_WIDTH_M = 7; // approaches without a section still shape the junction
const MIN_TRIM_M = 1;
const MERGE_FRACTION = 0.75; // trims consuming this much of an edge merge its junctions
const MIN_RADIUS_M = 1.2;
const MAX_TANGENT_FRACTION = 0.45; // of the approach length
const MIN_WEDGE_ANGLE = 0.6;       // rad (~35°) — no wedge in slip-lane slivers

/** Kerb radius defaults by the street classes meeting at the corner,
 *  metres — IRC:103-2012 kerb radii (verify against the document). */
const RADIUS_TABLE: Array<{ ranks: [string, string]; r: number }> = [
  { ranks: ['service', 'service'], r: 3 },
  { ranks: ['service', 'local'], r: 3.5 },
  { ranks: ['service', 'arterial'], r: 4.5 },
  { ranks: ['local', 'local'], r: 4.5 },
  { ranks: ['local', 'arterial'], r: 6 },
  { ranks: ['arterial', 'arterial'], r: 9 },
];

function classRank(highway?: string): 'service' | 'local' | 'arterial' {
  if (!highway) return 'local';
  if (['motorway', 'trunk', 'primary', 'secondary'].some((h) => highway.startsWith(h))) return 'arterial';
  if (['service', 'pedestrian', 'living_street'].includes(highway)) return 'service';
  return 'local';
}

function defaultRadius(a?: string, b?: string): number {
  const pair = [classRank(a), classRank(b)].sort() as [string, string];
  const hit = RADIUS_TABLE.find((t) => t.ranks[0] === pair[0] && t.ranks[1] === pair[1]);
  return hit?.r ?? 6;
}

// Flush-vs-raised split comes from the shared catalog set so junction curbs
// and element placement can never disagree.
const DRIVABLE = DRIVABLE_KINDS;

/** Corner handle metadata: identity + where to draw/drag it. */
export interface CornerInfo {
  key: string;         // `${edgeId}:${end}|${edgeId}:${end}` — stable across regeneration
  x: number;           // arc midpoint
  y: number;
  bx: number;          // unit vector from the midpoint toward the junction centre
  by: number;          //   (drag axis: inward = larger radius)
  radiusM: number | null; // null = chamfer
  overridden: boolean;
}

/** Approach (junction mouth) handle metadata. */
export interface ApproachInfo {
  key: string;         // `${edgeId}:${end}`
  edgeId: string;
  x: number;           // centerline point at the mouth
  y: number;
  dx: number;          // unit vector along the centerline, away from the junction
  dy: number;
  trim: number;
  maxTrim: number;
  overridden: boolean;
  entry: boolean;      // traffic may arrive at the junction on this approach
  exit: boolean;       // traffic may leave on it
}

export type TurnKind = 'left' | 'through' | 'right' | 'uturn';

/** One allowed movement between two approaches (Phase 2.5 / slice J4). */
export interface Movement {
  from: string;        // approach key
  to: string;
  turn: TurnKind;
  pts: number[];       // arrow path across the junction
}

export interface JunctionPoly {
  key: string;         // sorted node ids — JunctionDesign lookup key
  nodeIds: string[];
  degree: number;      // number of approaches
  polygon: number[];   // carriageway surface (curb ring with fillet arcs)
  coverBands: number[][]; // internal consumed edges, filled as junction surface
  wedges: RibbonBand[];   // corner wedges bridging raised stacks
  noses: RibbonBand[];    // median nose caps
  names: string[];
  corners: CornerInfo[];
  approachInfos: ApproachInfo[];
  movements: Movement[];
  /** Derived roundabout geometry when the design type is 'roundabout' and the
   *  junction is big enough: central island + circulatory carriageway. */
  roundabout?: { cx: number; cy: number; islandR: number; outerR: number };
}

export interface NodeTransition {
  nodeId: string;
  bands: RibbonBand[];
}

export interface EdgeTrim {
  start: number;
  end: number;
}

export interface NodeArtifacts {
  junctions: JunctionPoly[];
  transitions: NodeTransition[];
  trims: Record<string, EdgeTrim>;
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
  node: string;
  away: number[];
  len: number;
  rowHalfL: number;   // signed offset of the section's outer LEFT boundary
  rowHalfR: number;   // signed offset of the outer RIGHT boundary
  curbL: number;      // signed offset of the left curb (drivable boundary)
  curbR: number;
  stackL: SectionComponent[]; // raised stack outside-in on the left
  stackR: SectionComponent[]; // raised stack outside-in on the right
  leftCurbPts: number[];
  rightCurbPts: number[];
  angle: number;
}

function buildApproach(e: StreetEdge, nodeId: string, cx: number, cy: number): Approach {
  const away = pointsAwayFrom(e, nodeId);
  const len = polylineLength(away);
  const reversed = e.a !== nodeId;
  const comps = orientedComponents(e, reversed);
  const total = comps.reduce((s, c) => s + c.widthM, 0);

  let base: number, curbL: number, curbR: number;
  let stackL: SectionComponent[] = [];
  let stackR: SectionComponent[] = [];
  if (e.section && total > 0.5) {
    const f = reversed ? 1 - refFraction(e.section) : refFraction(e.section);
    base = total * f;
    let iL = 0;
    while (iL < comps.length && !DRIVABLE.has(comps[iL].kind)) iL++;
    let iR = comps.length - 1;
    while (iR >= 0 && !DRIVABLE.has(comps[iR].kind)) iR--;
    if (iL > iR) {
      // no drivable component (pure pedestrian street): treat as flush
      curbL = base;
      curbR = base - total;
    } else {
      stackL = comps.slice(0, iL); // already outside-in
      stackR = comps.slice(iR + 1).reverse(); // outside-in
      curbL = base - stackL.reduce((s, c) => s + c.widthM, 0);
      curbR = base - total + stackR.reduce((s, c) => s + c.widthM, 0);
    }
  } else {
    base = FALLBACK_WIDTH_M / 2;
    curbL = FALLBACK_WIDTH_M / 2;
    curbR = -FALLBACK_WIDTH_M / 2;
  }

  const probe = pointAtStation(away, Math.min(6, len * 0.5));
  return {
    edge: e,
    node: nodeId,
    away,
    len,
    rowHalfL: base,
    rowHalfR: e.section && total > 0.5 ? base - total : -FALLBACK_WIDTH_M / 2,
    curbL,
    curbR,
    stackL,
    stackR,
    leftCurbPts: offsetSide(away, curbL),
    rightCurbPts: offsetSide(away, curbR),
    angle: Math.atan2(probe.y - cy, probe.x - cx),
  };
}

/** Chaikin corner-cutting (endpoints kept): rounds the kinks of a chamfer
 *  fallback corner path so band normals rotate gradually instead of jumping. */
function chaikinSmooth(flat: number[], iterations = 2): number[] {
  let pts = toPts(flat);
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return toFlat(pts);
}

/** Drop points that double back against the row's direction of travel.
 *  Offsetting a kinked corner path (chamfer fallback) by a wide raised stack
 *  folds the offset row over itself — the band renders as a bow-tie spike.
 *  Clamping to monotone progress pinches the band instead. */
function unfoldRow(row: number[]): number[] {
  if (row.length < 6) return row;
  const out = [row[0], row[1]];
  let dx = 0, dy = 0;
  for (let i = 2; i + 1 < row.length; i += 2) {
    const sx = row[i] - out[out.length - 2];
    const sy = row[i + 1] - out[out.length - 1];
    const len = Math.hypot(sx, sy);
    if (len < 0.02) continue;
    if (dx * sx + dy * sy < 0) continue; // fold
    out.push(row[i], row[i + 1]);
    dx = sx / len;
    dy = sy / len;
  }
  return out;
}

/** Wedge band polygons are two offset rows (upper + reversed lower); unfold each. */
function unfoldBand(polygon: number[]): number[] {
  const half = polygon.length / 2;
  const evenHalf = half - (half % 2);
  return [...unfoldRow(polygon.slice(0, evenHalf)), ...unfoldRow(polygon.slice(evenHalf))];
}

interface Corner {
  arc: number[];        // fillet polyline from A-side tangent to B-side tangent
  sTAcurb: number;      // tangent station on A's right curb
  sTBcurb: number;      // tangent station on B's left curb
  clA: number;          // centerline trim demanded on A
  clB: number;          // centerline trim demanded on B
  radiusM: number | null; // radius actually used (null = chamfer fallback)
}

/** Tangent arc of radius R between a's right curb and b's left curb; shrinks R to fit. */
function solveCorner(a: Approach, b: Approach, ov?: CornerOverride): Corner {
  const capA = a.len * MAX_TANGENT_FRACTION;
  const capB = b.len * MAX_TANGENT_FRACTION;

  // The mouth must clear at ROW level or the two ribbons (with their raised
  // bands) invade each other's corner quadrant — the arc is curb geometry,
  // the trim is ROW geometry.
  let rowA = MIN_TRIM_M;
  let rowB = MIN_TRIM_M;
  const outerA = offsetSide(a.away, a.rowHalfR);
  const outerB = offsetSide(b.away, b.rowHalfL);
  const rowHit = firstHit(outerA, outerB) ?? firstSegLineHit(outerA, outerB);
  if (rowHit) {
    rowA = Math.min(projectOnPolyline(a.away, rowHit.x, rowHit.y)?.station ?? MIN_TRIM_M, capA);
    rowB = Math.min(projectOnPolyline(b.away, rowHit.x, rowHit.y)?.station ?? MIN_TRIM_M, capB);
  }

  let R = ov?.radiusM ?? defaultRadius(a.edge.highway, b.edge.highway);

  while (!ov?.chamfer && R >= MIN_RADIUS_M) {
    // The fillet centre sits in the corner quadrant (inside the block corner),
    // R beyond each curb on the NON-drivable side — offsetting toward the
    // centreline instead puts tangents on the node side and the arc doubles back.
    const cA = offsetSide(a.away, a.curbR - R);
    const cB = offsetSide(b.away, b.curbL + R);
    const center = firstHit(cA, cB) ?? firstSegLineHit(cA, cB);
    if (center) {
      const pA = projectOnPolyline(a.rightCurbPts, center.x, center.y);
      const pB = projectOnPolyline(b.leftCurbPts, center.x, center.y);
      if (pA && pB && Math.abs(pA.dist - R) < R * 0.35 && Math.abs(pB.dist - R) < R * 0.35) {
        const clA = projectOnPolyline(a.away, pA.x, pA.y)?.station ?? pA.station;
        const clB = projectOnPolyline(b.away, pB.x, pB.y)?.station ?? pB.station;
        if (clA <= capA && clB <= capB) {
          // Sample the arc from T_A to T_B. Start with the short sweep, but
          // the fillet must CONTINUE the incoming curb direction at T_A —
          // if the short sweep leaves T_A backwards, take the complement,
          // or the whole corner path doubles back and its normals flip.
          const a0 = Math.atan2(pA.y - center.y, pA.x - center.x);
          const a1 = Math.atan2(pB.y - center.y, pB.x - center.x);
          let sweep = a1 - a0;
          while (sweep > Math.PI) sweep -= 2 * Math.PI;
          while (sweep < -Math.PI) sweep += 2 * Math.PI;
          const tangentAtTA = pointAtStation(a.rightCurbPts, pA.station);
          // inbound direction (toward the node) = reversed curb tangent
          const inX = tangentAtTA.ny;
          const inY = -tangentAtTA.nx;
          const arcInitX = -Math.sin(a0) * Math.sign(sweep);
          const arcInitY = Math.cos(a0) * Math.sign(sweep);
          if (inX * arcInitX + inY * arcInitY < 0) {
            sweep = sweep - Math.sign(sweep) * 2 * Math.PI;
          }
          const arcLen = Math.abs(sweep) * R;
          const N = Math.max(4, Math.ceil(arcLen / 1.2));
          const arc: number[] = [];
          for (let k = 0; k <= N; k++) {
            const t = a0 + (sweep * k) / N;
            arc.push(center.x + R * Math.cos(t), center.y + R * Math.sin(t));
          }
          return { arc, sTAcurb: pA.station, sTBcurb: pB.station, clA: Math.max(clA, rowA), clB: Math.max(clB, rowB), radiusM: R };
        }
      }
    }
    R *= 0.75;
  }

  // Fallback: chamfer at the curb-line collision (near-parallel / degenerate pairs)
  const hit =
    firstHit(a.rightCurbPts, b.leftCurbPts) ??
    firstSegLineHit(a.rightCurbPts, b.leftCurbPts) ?? {
      x: (a.rightCurbPts[0] + b.leftCurbPts[0]) / 2,
      y: (a.rightCurbPts[1] + b.leftCurbPts[1]) / 2,
    };
  const pA = projectOnPolyline(a.rightCurbPts, hit.x, hit.y);
  const pB = projectOnPolyline(b.leftCurbPts, hit.x, hit.y);
  const sA = Math.min(pA?.station ?? MIN_TRIM_M, capA);
  const sB = Math.min(pB?.station ?? MIN_TRIM_M, capB);
  const qA = pointAtStation(a.rightCurbPts, sA);
  const qB = pointAtStation(b.leftCurbPts, sB);
  return {
    arc: [qA.x, qA.y, qB.x, qB.y],
    sTAcurb: sA,
    sTBcurb: sB,
    clA: Math.max(Math.min(projectOnPolyline(a.away, qA.x, qA.y)?.station ?? sA, capA), rowA),
    clB: Math.max(Math.min(projectOnPolyline(b.away, qB.x, qB.y)?.station ?? sB, capB), rowB),
    radiusM: null,
  };
}

interface ClusterResult {
  poly: JunctionPoly;
  trims: Array<{ edgeId: string; end: 'start' | 'end'; trim: number }>;
}

const endOf = (e: StreetEdge, node: string): 'start' | 'end' => (e.a === node ? 'start' : 'end');
const approachKey = (a: Approach) => `${a.edge.id}:${endOf(a.edge, a.node)}`;

function classifyTurn(dInX: number, dInY: number, dOutX: number, dOutY: number): TurnKind {
  // Signed angle from the entry direction to the exit direction; in y-down
  // coordinates a positive angle is a clockwise (right, LHT) turn.
  const deg = (Math.atan2(dInX * dOutY - dInY * dOutX, dInX * dOutX + dInY * dOutY) * 180) / Math.PI;
  if (Math.abs(deg) <= 30) return 'through';
  if (Math.abs(deg) >= 150) return 'uturn';
  return deg > 0 ? 'right' : 'left';
}

function computeJunction(
  g: GraphState,
  nodeIds: string[],
  edges: StreetEdge[],
  design?: JunctionDesign,
  blend = true,
): ClusterResult | null {
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

  const approaches = approachesRaw
    .map(({ edge, node }) => buildApproach(edge, node, cx, cy))
    .sort((p, q) => p.angle - q.angle); // ascending atan2 = clockwise in y-down

  const k = approaches.length;
  const cornerKeys: string[] = [];
  const corners: Corner[] = [];
  for (let i = 0; i < k; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % k];
    const key = `${approachKey(a)}|${approachKey(b)}`;
    cornerKeys.push(key);
    corners.push(solveCorner(a, b, design?.cornerOverrides[key]));
  }

  // Ribbon trim per approach: the larger tangent demand of its two corners,
  // unless the user pinned this mouth explicitly.
  const trims: number[] = approaches.map((a, i) => {
    const maxTrim = a.len * MAX_TANGENT_FRACTION;
    const demandL = corners[(i - 1 + k) % k].clB; // corner on my left curb
    const demandR = corners[i].clA;               // corner on my right curb
    const floor = Math.max(MIN_TRIM_M, demandL, demandR);
    const ovTrim = design?.approachOverrides[approachKey(a)]?.trimM;
    // An override can extend the mouth but never pull it inside the fillet
    // region — the surface ring would grow a tongue over the approach ribbon.
    const t = ovTrim !== undefined ? Math.max(ovTrim, floor) : floor;
    return Math.min(t, maxTrim);
  });

  // Surface ring: mouth caps at curb offsets + curb segments + fillet arcs.
  const ring: number[] = [];
  const wedges: RibbonBand[] = [];
  approaches.forEach((a, i) => {
    const next = approaches[(i + 1) % k];
    const corner = corners[i];
    const p = pointAtStation(a.away, trims[i]);
    const pl = { x: p.x + p.nx * a.curbL, y: p.y + p.ny * a.curbL };
    const pr = { x: p.x + p.nx * a.curbR, y: p.y + p.ny * a.curbR };
    const pNext = pointAtStation(next.away, trims[(i + 1) % k]);
    const plNext = { x: pNext.x + pNext.nx * next.curbL, y: pNext.y + pNext.ny * next.curbL };

    ring.push(pl.x, pl.y, pr.x, pr.y);

    // walk my right curb from the mouth down to the tangent point…
    const sPr = projectOnPolyline(a.rightCurbPts, pr.x, pr.y)?.station ?? trims[i];
    const segA = sPr > corner.sTAcurb + 0.05 ? subPolyline(a.rightCurbPts, corner.sTAcurb, sPr) : null;
    const segARev: number[] = [];
    if (segA) for (let m = segA.length - 2; m >= 0; m -= 2) segARev.push(segA[m], segA[m + 1]);
    // …around the fillet arc…
    // …and up the neighbour's left curb to its mouth.
    const sPlNext = projectOnPolyline(next.leftCurbPts, plNext.x, plNext.y)?.station ?? trims[(i + 1) % k];
    const segB = sPlNext > corner.sTBcurb + 0.05 ? subPolyline(next.leftCurbPts, corner.sTBcurb, sPlNext) : null;

    ring.push(...segARev, ...corner.arc, ...(segB ?? []));

    // Corner wedge: raised stacks bridge outward along the same corner path.
    const stackA = a.stackR;
    const stackB = next.stackL;
    // Very acute corners (slip lanes, Y-merges): the sliver between two
    // near-parallel streets can't carry a sensible wedge — the bands would
    // lie across the mouths. Leave the surface bare (probe method, slice J7).
    const angularGap =
      (((approaches[(i + 1) % k].angle - a.angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // Corner wedges blend unmatched raised stacks around the corner; with
    // blending off (settings default) the bands simply end at the mouths.
    if (blend && (stackA.length > 0 || stackB.length > 0) && angularGap > MIN_WEDGE_ANGLE) {
      // dedupe joints: duplicated points make zero-length segments whose
      // normals vanish and pinch the sampled bands into spikes
      let path = chaikinSmooth(toFlat(dedupePts(toPts([...segARev, ...corner.arc, ...(segB ?? [])]), 0.08)));
      const pathLen = polylineLength(path);
      if (path.length >= 4 && pathLen > 0.3) {
        // Bands offset to the LEFT of the path — that must be OUTWARD (away
        // from the junction). Test at the midpoint and reverse if not.
        const mid = pointAtStation(path, pathLen / 2);
        const towardOut =
          dist(mid.x + mid.nx, mid.y + mid.ny, cx, cy) > dist(mid.x, mid.y, cx, cy);
        let [s1, s2] = towardOut ? [stackA, stackB] : [stackB, stackA];
        if (!towardOut) {
          const rev: number[] = [];
          for (let m = path.length - 2; m >= 0; m -= 2) rev.push(path[m], path[m + 1]);
          path = rev;
        }
        let matched = matchComponents(s1, s2);
        // Wholly unmatched stacks (footpath meeting a green verge): drop/
        // introduce tapers would sweep slivers across both mouths. Pave the
        // corner as ONE apron instead — a single band morphing between the
        // stack totals, in the wider stack's outermost material.
        if (!matched.some((c) => c.w1 > 0.01 && c.w2 > 0.01)) {
          const t1 = s1.reduce((s, c) => s + c.widthM, 0);
          const t2 = s2.reduce((s, c) => s + c.widthM, 0);
          const donor = (t1 >= t2 ? s1[0] : s2[0]) ?? s1[0] ?? s2[0];
          matched = [{ element: donor.element, kind: donor.kind, w1: t1, w2: t2 }];
        }
        wedges.push(
          ...sampleTransitionBands(path, matched, 0, pathLen, `w${i}`, 1, 1).map((b) => ({
            ...b,
            key: `j-${b.key}`,
            polygon: unfoldBand(b.polygon),
          })),
        );
      }
    }
  });

  // Median noses: a divided approach's median ends in a rounded cap at the mouth.
  const noses: RibbonBand[] = [];
  approaches.forEach((a, i) => {
    const comps = orientedComponents(a.edge, a.edge.a !== a.node);
    if (!a.edge.section) return;
    const total = comps.reduce((s, c) => s + c.widthM, 0);
    const f = a.edge.a !== a.node ? 1 - refFraction(a.edge.section) : refFraction(a.edge.section);
    let off = total * f;
    comps.forEach((c, ci) => {
      const isInnerMedian = c.kind === 'median' && ci > 0 && ci < comps.length - 1;
      if (isInnerMedian && c.widthM > 0.3) {
        // Rounded nose: a circle cap centred on the median end at the mouth
        // (visually a semicircular nose at plan scale — the ribbon covers the
        // half that overlaps the median band).
        const mid = off - c.widthM / 2;
        const r = c.widthM / 2;
        const p = pointAtStation(a.away, trims[i]);
        const cxm = p.x + p.nx * mid;
        const cym = p.y + p.ny * mid;
        const circle: number[] = [];
        for (let t = 0; t < 14; t++) {
          const ang = (2 * Math.PI * t) / 14;
          circle.push(cxm + r * Math.cos(ang), cym + r * Math.sin(ang));
        }
        noses.push({ key: `nose-${i}-${ci}`, element: c.element, kind: c.kind, widthM: c.widthM, polygon: circle });
      }
      off -= c.widthM;
    });
  });

  const coverBands = internal.map((e) => {
    const w = e.section
      ? e.section.components.reduce((s, c) => s + c.widthM, 0)
      : FALLBACK_WIDTH_M;
    return ribbonBand(toPts(e.points), w / 2, -w / 2);
  });

  // Handle metadata: corner dots on arc midpoints, approach squares at mouths.
  const cornerInfos: CornerInfo[] = corners.map((c, i) => {
    const len = polylineLength(c.arc);
    const mid = pointAtStation(c.arc, len / 2);
    const d = Math.max(dist(mid.x, mid.y, cx, cy), 1e-6);
    return {
      key: cornerKeys[i],
      x: mid.x,
      y: mid.y,
      bx: (cx - mid.x) / d,
      by: (cy - mid.y) / d,
      radiusM: c.radiusM,
      overridden: !!design?.cornerOverrides[cornerKeys[i]],
    };
  });

  const approachInfos: ApproachInfo[] = approaches.map((a, i) => {
    const p = pointAtStation(a.away, trims[i]);
    // away-tangent from the left normal (n = (ty, -tx) → t = (-ny, nx))
    const key = approachKey(a);
    const isEnd = endOf(a.edge, a.node) === 'end';
    return {
      key,
      edgeId: a.edge.id,
      x: p.x,
      y: p.y,
      dx: -p.ny,
      dy: p.nx,
      trim: trims[i],
      maxTrim: a.len * MAX_TANGENT_FRACTION,
      overridden: design?.approachOverrides[key]?.trimM !== undefined,
      entry: !a.edge.oneway || isEnd,  // oneway travels a→b: arrives here only at its b end
      exit: !a.edge.oneway || !isEnd,
    };
  });

  // Movement graph (J4): every permitted entry→exit pair, classified by the
  // signed turn angle (left-hand traffic; right turns cross the junction).
  const movements: Movement[] = [];
  approachInfos.forEach((ain) => {
    if (!ain.entry) return;
    approachInfos.forEach((aout) => {
      if (aout === ain || !aout.exit) return;
      const turn = classifyTurn(-ain.dx, -ain.dy, aout.dx, aout.dy);
      const pts: number[] = [];
      for (let t = 0; t <= 1.0001; t += 1 / 12) {
        const u = 1 - t;
        pts.push(
          u * u * ain.x + 2 * u * t * cx + t * t * aout.x,
          u * u * ain.y + 2 * u * t * cy + t * t * aout.y,
        );
      }
      movements.push({ from: ain.key, to: aout.key, turn, pts });
    });
  });

  // Roundabout form (Junction_Tool_Design J6 preview): island + circulatory
  // sized from the tightest approach mouth. IRC urban circulatory ≈ 7 m.
  let roundabout: JunctionPoly['roundabout'];
  if (design?.type === 'roundabout' && approachInfos.length > 0) {
    const minMouth = Math.min(...approachInfos.map((a) => dist(a.x, a.y, cx, cy)));
    if (Number.isFinite(minMouth) && minMouth >= 6) {
      const outerR = minMouth * 0.92;
      roundabout = { cx, cy, islandR: Math.max(1.5, outerR - 7), outerR };
    }
  }

  return {
    poly: {
      key: [...nodeIds].sort().join('+'),
      nodeIds,
      degree: k,
      polygon: ring,
      coverBands,
      wedges,
      noses,
      names: [...new Set(approaches.map((a) => a.edge.name).filter(Boolean))] as string[],
      corners: cornerInfos,
      approachInfos,
      movements,
      ...(roundabout ? { roundabout } : {}),
    },
    trims: [
      ...approaches.map((a, i) => ({
        edgeId: a.edge.id,
        end: (a.edge.a === a.node ? 'start' : 'end') as 'start' | 'end',
        trim: trims[i],
      })),
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

  let fIn = refFraction(eIn.section);
  let fOut = refFraction(eOut.section);
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

// Single-entry cache: canvas, panels, suggestions and export all derive from
// the same (nodes, edges, designs) identities — one derivation per state change.
let lastDerive: {
  nodes: GraphState['nodes'];
  edges: GraphState['edges'];
  designs: Record<string, JunctionDesign> | undefined;
  blend: boolean;
  result: NodeArtifacts;
} | null = null;

export function deriveNodeArtifactsCached(
  g: GraphState,
  designs?: Record<string, JunctionDesign>,
  blend = true,
): NodeArtifacts {
  if (
    lastDerive &&
    lastDerive.nodes === g.nodes &&
    lastDerive.edges === g.edges &&
    lastDerive.designs === designs &&
    lastDerive.blend === blend
  ) {
    return lastDerive.result;
  }
  const result = deriveNodeArtifacts(g, designs, blend);
  lastDerive = { nodes: g.nodes, edges: g.edges, designs, blend, result };
  return result;
}

/** One pass over all nodes → junction polygons (merged where colliding), node transitions, edge trims. */
export function deriveNodeArtifacts(
  g: GraphState,
  designs?: Record<string, JunctionDesign>,
  blend = true,
): NodeArtifacts {
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

  // Pass 1: singleton results decide which shared edges are consumed AND are
  // reused verbatim for singleton clusters in pass 2 (a singleton's design
  // key is its node id, so overrides participate in the merge decision too).
  const singleTrim = new Map<string, number>();
  const singleRes = new Map<string, ClusterResult | null>();
  for (const nid of junctionNodes) {
    const res = computeJunction(g, [nid], byNode.get(nid)!, designs?.[nid], blend);
    singleRes.set(nid, res);
    res?.trims.forEach((t) => singleTrim.set(`${t.edgeId}:${t.end}`, t.trim));
  }

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

  for (const nodeIds of clusters.values()) {
    let res: ClusterResult | null;
    if (nodeIds.length === 1) {
      res = singleRes.get(nodeIds[0]) ?? null;
    } else {
      const edgeSet = new Map<string, StreetEdge>();
      for (const nid of nodeIds) for (const e of byNode.get(nid)!) edgeSet.set(e.id, e);
      res = computeJunction(g, nodeIds, [...edgeSet.values()], designs?.[[...nodeIds].sort().join('+')], blend);
    }
    if (res) {
      junctions.push(res.poly);
      res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
    }
  }

  for (const [nodeId, edges] of byNode) {
    if (edges.length === 2 && edges[0].id !== edges[1].id) {
      // Two parallel edges between the same node pair (a drawn loop) would
      // produce a hairpin transition path folding back over both ribbons.
      const far = (e: StreetEdge) => (e.a === nodeId ? e.b : e.a);
      if (far(edges[0]) === far(edges[1])) continue;
      const res = transitionForNode(nodeId, edges[0], edges[1]);
      if (res) {
        transitions.push({ nodeId, bands: res.bands });
        res.trims.forEach((t) => addTrim(t.edgeId, t.end, t.trim));
      }
    }
  }
  return { junctions, transitions, trims };
}
