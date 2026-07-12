// Stage 3 detailing: parametric street elements.
// Every element lives at (edge, station, component, fraction) — pure geometry
// derived on render, so elements follow the alignment and stay inside their
// designated component (trees in green belts, lights on footpaths, arrows on
// carriageways). Shared graphic primitives feed both the canvas and the SVG
// export so plan output matches the screen.
import type {
  ComponentKind,
  EdgeSection,
  ElementKind,
  GraphState,
  StreetEdge,
  StreetElement,
} from '../types';
import { refFraction } from '../geometry/ribbon';
import { edgesNear } from '../geometry/spatialIndex';
import { DRIVABLE_KINDS } from '../catalog';
import { pointAtStation, polylineLength, projectOnPolyline, subPolyline, offsetPolyline, toPts, toFlat } from '../geometry/polyline';

const DRIVABLE = DRIVABLE_KINDS;

/** Component kinds each element may occupy (the movement constraint). */
export const ALLOWED: Record<ElementKind, ComponentKind[] | 'drivable' | 'raised-side'> = {
  tree: ['tree', 'buffer', 'livability', 'footpath', 'median', 'muz', 'mfz'],
  streetlight: ['footpath', 'median', 'buffer', 'tree', 'muz', 'mfz', 'livability'],
  dustbin: ['footpath', 'muz', 'mfz', 'busstop', 'livability'],
  bench: ['footpath', 'muz', 'mfz', 'busstop', 'livability'],
  bollard: ['footpath', 'muz', 'mfz', 'livability', 'buffer'],
  busstop: ['footpath', 'busstop', 'muz', 'mfz'],
  turnarrow: ['carriageway', 'mixed', 'service', 'brt'],
  zebra: 'drivable',
  raisedcrossing: 'drivable',
  driveway: 'raised-side',
};

export const ELEMENT_LABELS: Record<ElementKind, string> = {
  tree: 'Tree',
  streetlight: 'Street light',
  dustbin: 'Dustbin',
  bench: 'Bench',
  bollard: 'Bollard',
  busstop: 'Bus stop',
  turnarrow: 'Turn arrow',
  zebra: 'Zebra crossing',
  raisedcrossing: 'Raised crossing',
  driveway: 'Driveway',
};

export const DEFAULT_WIDTH: Partial<Record<ElementKind, number>> = {
  zebra: 3,
  raisedcrossing: 4,
  driveway: 5,
};

/** Signed offsets (positive = left of the centerline) of a component's edges. */
export function componentSpan(section: EdgeSection, compIndex: number): { hi: number; lo: number } | null {
  const comps = section.components;
  if (compIndex < 0 || compIndex >= comps.length) return null;
  const total = comps.reduce((s, c) => s + c.widthM, 0);
  let hi = total * refFraction(section);
  for (let i = 0; i < compIndex; i++) hi -= comps[i].widthM;
  return { hi, lo: hi - comps[compIndex].widthM };
}

/** Signed offsets of the drivable group (outermost drivable boundaries). */
export function drivableSpan(section: EdgeSection): { hi: number; lo: number } | null {
  const comps = section.components;
  const total = comps.reduce((s, c) => s + c.widthM, 0);
  if (total < 0.5) return null;
  let iL = 0;
  while (iL < comps.length && !DRIVABLE.has(comps[iL].kind)) iL++;
  let iR = comps.length - 1;
  while (iR >= 0 && !DRIVABLE.has(comps[iR].kind)) iR--;
  if (iL > iR) return null;
  const base = total * refFraction(section);
  const hi = base - comps.slice(0, iL).reduce((s, c) => s + c.widthM, 0);
  const lo = base - total + comps.slice(iR + 1).reduce((s, c) => s + c.widthM, 0);
  return { hi, lo };
}

/** Signed offset of a world point relative to an edge centerline at a projection. */
function signedOffset(edge: StreetEdge, wx: number, wy: number, station: number): number {
  const p = pointAtStation(edge.points, station);
  return (wx - p.x) * p.nx + (wy - p.y) * p.ny;
}

export interface Placement {
  edgeId: string;
  stationM: number;
  compIndex: number;
  t: number;
}

/** Resolve a world point to a legal anchor for `kind` on `edge` (or null). */
export function resolveOnEdge(edge: StreetEdge, kind: ElementKind, wx: number, wy: number): Placement | null {
  if (!edge.section) return null;
  const proj = projectOnPolyline(edge.points, wx, wy);
  if (!proj) return null;
  const L = polylineLength(edge.points);
  const station = Math.min(Math.max(proj.station, 0.5), Math.max(L - 0.5, 0.5));
  const off = signedOffset(edge, wx, wy, station);
  const comps = edge.section.components;
  const allowed = ALLOWED[kind];

  if (allowed === 'drivable') {
    const span = drivableSpan(edge.section);
    if (!span || off > span.hi + 6 || off < span.lo - 6) return null;
    return { edgeId: edge.id, stationM: station, compIndex: -1, t: 0.5 };
  }

  if (allowed === 'raised-side') {
    // anchor to the outermost raised component on the clicked side
    const span = drivableSpan(edge.section);
    if (!span) return null;
    const left = off >= (span.hi + span.lo) / 2;
    const idx = left ? 0 : comps.length - 1;
    if (DRIVABLE.has(comps[idx].kind)) return null; // no raised stack on that side
    return { edgeId: edge.id, stationM: station, compIndex: idx, t: 0.5 };
  }

  // point element: nearest allowed component, exact fraction when inside it
  let best: { compIndex: number; t: number; d: number } | null = null;
  for (let i = 0; i < comps.length; i++) {
    if (!allowed.includes(comps[i].kind)) continue;
    const span = componentSpan(edge.section, i)!;
    const w = span.hi - span.lo;
    if (w < 0.2) continue;
    const inset = Math.min(0.3, w * 0.15); // keep the symbol inside the band
    const clamped = Math.min(Math.max(off, span.lo + inset), span.hi - inset);
    const d = Math.abs(off - clamped);
    if (!best || d < best.d) best = { compIndex: i, t: (span.hi - clamped) / w, d };
  }
  if (!best || best.d > 8) return null;
  return { edgeId: edge.id, stationM: station, compIndex: best.compIndex, t: best.t };
}

/** Resolve a drop anywhere on the network: nearest edge that accepts `kind`.
 *  The gate is centerline distance within `tolM` PLUS the section half-width,
 *  so a click on a wide section's outer band (well beyond the centerline)
 *  still resolves to that edge. */
export function resolveDrop(g: GraphState, kind: ElementKind, wx: number, wy: number, tolM: number): Placement | null {
  let best: { p: Placement; d: number } | null = null;
  // 60 m covers the widest catalog ROW's half-width beyond the centerline.
  for (const e of edgesNear(g, wx, wy, tolM + 60)) {
    if (!e.section) continue;
    const proj = projectOnPolyline(e.points, wx, wy);
    if (!proj) continue;
    const total = e.section.components.reduce((s, c) => s + c.widthM, 0);
    if (proj.dist > tolM + total) continue;
    const p = resolveOnEdge(e, kind, wx, wy);
    if (p && (!best || proj.dist < best.d)) best = { p, d: proj.dist };
  }
  return best?.p ?? null;
}

/** World position + frame for a point element. */
export function elementFrame(edge: StreetEdge, el: StreetElement) {
  const span = edge.section ? componentSpan(edge.section, el.compIndex) : null;
  const off = span ? span.hi - el.t * (span.hi - span.lo) : 0;
  const p = pointAtStation(edge.points, el.stationM);
  return {
    x: p.x + p.nx * off,
    y: p.y + p.ny * off,
    nx: p.nx,
    ny: p.ny,
    tx: -p.ny, // forward tangent
    ty: p.nx,
    off,
  };
}

// ── Graphics: shared by canvas and SVG export ───────────────────────────

export interface Graphic {
  shape: 'circle' | 'poly' | 'line';
  pts?: number[];      // poly/line
  x?: number;          // circle
  y?: number;
  r?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  closed?: boolean;
  dash?: number[];
}

/** Rectangle aligned to the street frame at (station, offset), h along street, w across. */
function frameRect(edge: StreetEdge, station: number, off: number, h: number, w: number): number[] {
  const p1 = pointAtStation(edge.points, station - h / 2);
  const p2 = pointAtStation(edge.points, station + h / 2);
  return [
    p1.x + p1.nx * (off + w / 2), p1.y + p1.ny * (off + w / 2),
    p2.x + p2.nx * (off + w / 2), p2.y + p2.ny * (off + w / 2),
    p2.x + p2.nx * (off - w / 2), p2.y + p2.ny * (off - w / 2),
    p1.x + p1.nx * (off - w / 2), p1.y + p1.ny * (off - w / 2),
  ];
}

export function elementGraphics(edge: StreetEdge, el: StreetElement): Graphic[] {
  // Stale anchors (component deleted, section removed) render nothing rather
  // than falling back to the centerline; the store prunes them on mutation.
  if (!edge.section || !isElementValid(edge, el)) return [];
  const L = polylineLength(edge.points);
  const s = Math.min(Math.max(el.stationM, 0.3), L - 0.3);

  if (el.kind === 'zebra' || el.kind === 'raisedcrossing') {
    const span = drivableSpan(edge.section);
    if (!span) return [];
    const w = el.widthM ?? DEFAULT_WIDTH[el.kind]!;
    const out: Graphic[] = [];
    if (el.kind === 'raisedcrossing') {
      out.push({ shape: 'poly', pts: frameRect(edge, s, (span.hi + span.lo) / 2, w + 1.6, span.hi - span.lo), fill: '#9aa1ab', closed: true });
    }
    // longitudinal bars, IRC-style zebra
    for (let o = span.lo + 0.5; o <= span.hi - 0.5; o += 1.2) {
      out.push({ shape: 'poly', pts: frameRect(edge, s, o + 0.3, w, 0.6), fill: '#f2f0e9', closed: true });
    }
    return out;
  }

  if (el.kind === 'driveway') {
    const span = edge.section ? componentSpan(edge.section, el.compIndex) : null;
    const drv = drivableSpan(edge.section);
    if (!span || !drv) return [];
    const comps = edge.section.components;
    const total = comps.reduce((sum, c) => sum + c.widthM, 0);
    const base = total * refFraction(edge.section);
    const left = el.compIndex === 0 || span.hi > drv.hi;
    const rowEdge = left ? base : base - total;   // outer boundary on that side
    const curb = left ? drv.hi : drv.lo;          // drivable boundary on that side
    const w = el.widthM ?? DEFAULT_WIDTH.driveway!;
    const pOut1 = pointAtStation(edge.points, s - w / 2);
    const pOut2 = pointAtStation(edge.points, s + w / 2);
    const pIn1 = pointAtStation(edge.points, s - w / 2 - 1);
    const pIn2 = pointAtStation(edge.points, s + w / 2 + 1);
    return [
      {
        shape: 'poly',
        pts: [
          pOut1.x + pOut1.nx * rowEdge, pOut1.y + pOut1.ny * rowEdge,
          pOut2.x + pOut2.nx * rowEdge, pOut2.y + pOut2.ny * rowEdge,
          pIn2.x + pIn2.nx * curb, pIn2.y + pIn2.ny * curb,   // flared at the curb
          pIn1.x + pIn1.nx * curb, pIn1.y + pIn1.ny * curb,
        ],
        fill: '#b9b2a4',
        stroke: 'rgba(60,55,45,0.5)',
        strokeWidth: 0.5,
        closed: true,
      },
    ];
  }

  const f = elementFrame(edge, el);
  switch (el.kind) {
    case 'tree':
      return [
        { shape: 'circle', x: f.x, y: f.y, r: 1.6, fill: 'rgba(74,124,63,0.8)', stroke: '#3c6132', strokeWidth: 0.3 },
        { shape: 'circle', x: f.x, y: f.y, r: 0.25, fill: '#5d4327' },
      ];
    case 'streetlight':
      return [
        { shape: 'circle', x: f.x, y: f.y, r: 1.1, fill: 'rgba(240,200,90,0.35)' },
        { shape: 'circle', x: f.x, y: f.y, r: 0.3, fill: '#38404a' },
      ];
    case 'dustbin':
      return [{ shape: 'poly', pts: frameRect(edge, s, f.off, 0.7, 0.7), fill: '#2e6e4e', closed: true }];
    case 'bench':
      return [{ shape: 'poly', pts: frameRect(edge, s, f.off, 1.6, 0.5), fill: '#7a5230', closed: true }];
    case 'bollard':
      return [{ shape: 'circle', x: f.x, y: f.y, r: 0.22, fill: '#38404a', stroke: '#f2f0e9', strokeWidth: 0.12 }];
    case 'busstop':
      return [
        { shape: 'poly', pts: frameRect(edge, s, f.off, 6, 1.8), fill: 'rgba(179,84,30,0.25)', stroke: '#b3541e', strokeWidth: 0.5, closed: true },
        { shape: 'poly', pts: frameRect(edge, s, f.off, 5.2, 0.4), fill: '#b3541e', closed: true },
      ];
    case 'turnarrow': {
      const len = 3;
      const ax = f.x - f.tx * (len / 2);
      const ay = f.y - f.ty * (len / 2);
      const tip = { x: f.x + f.tx * (len / 2), y: f.y + f.ty * (len / 2) };
      const pts = [ax, ay, tip.x, tip.y];
      const out: Graphic[] = [{ shape: 'line', pts, stroke: '#f2f0e9', strokeWidth: 0.4 }];
      const dir = el.variant === 'left' ? 1 : el.variant === 'right' ? -1 : 0;
      if (dir === 0) {
        // straight head
        out.push({
          shape: 'poly',
          pts: [
            tip.x + f.tx * 0.9, tip.y + f.ty * 0.9,
            tip.x + f.nx * 0.45, tip.y + f.ny * 0.45,
            tip.x - f.nx * 0.45, tip.y - f.ny * 0.45,
          ],
          fill: '#f2f0e9',
          closed: true,
        });
      } else {
        // bend + head sideways (dir=1 → left normal side)
        const bx = tip.x + f.nx * 1.1 * dir;
        const by = tip.y + f.ny * 1.1 * dir;
        out.push({ shape: 'line', pts: [tip.x, tip.y, bx, by], stroke: '#f2f0e9', strokeWidth: 0.4 });
        out.push({
          shape: 'poly',
          pts: [
            bx + f.nx * 0.9 * dir, by + f.ny * 0.9 * dir,
            bx + f.tx * 0.45, by + f.ty * 0.45,
            bx - f.tx * 0.45, by - f.ty * 0.45,
          ],
          fill: '#f2f0e9',
          closed: true,
        });
      }
      return out;
    }
  }
  return [];
}

/** Lane divider markings for an edge (edge.lanes per carriageway). */
export function laneDividers(edge: StreetEdge, trim?: { start: number; end: number }): number[][] {
  const lanes = edge.lanes ?? 0;
  if (!edge.section || lanes < 2) return [];
  const L = polylineLength(edge.points);
  const s0 = trim?.start ?? 0;
  const s1 = L - (trim?.end ?? 0);
  if (s1 - s0 < 2) return [];
  const sub = subPolyline(edge.points, s0, s1);
  const out: number[][] = [];
  edge.section.components.forEach((c, i) => {
    if (c.kind !== 'carriageway' && c.kind !== 'brt') return;
    const span = componentSpan(edge.section!, i)!;
    for (let k = 1; k < lanes; k++) {
      const off = span.hi - ((span.hi - span.lo) * k) / lanes;
      out.push(toFlat(offsetPolyline(toPts(sub), off)));
    }
  });
  return out;
}

// ── Suggestions ──────────────────────────────────────────────────────────

const SUGGEST_RULES: Partial<Record<ElementKind, { kinds: ComponentKind[]; spacing: number; minWidth: number }>> = {
  tree: { kinds: ['tree', 'buffer', 'livability', 'median'], spacing: 8, minWidth: 1 },
  streetlight: { kinds: ['footpath', 'median'], spacing: 25, minWidth: 1 },
  dustbin: { kinds: ['footpath'], spacing: 80, minWidth: 1.2 },
};

/** Evenly spaced suggestions inside eligible belts, skipping occupied spots. */
export function suggestElements(
  g: GraphState,
  kind: ElementKind,
  existing: StreetElement[],
  trims: Record<string, { start: number; end: number }>,
): Array<Omit<StreetElement, 'id'>> {
  const rule = SUGGEST_RULES[kind];
  if (!rule) return [];
  const out: Array<Omit<StreetElement, 'id'>> = [];
  const taken = existing.filter((e) => e.kind === kind);
  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const L = polylineLength(e.points);
    const from = (trims[e.id]?.start ?? 0) + 2;
    const to = L - (trims[e.id]?.end ?? 0) - 2;
    if (to - from < rule.spacing / 2) continue;
    e.section.components.forEach((c, i) => {
      if (!rule.kinds.includes(c.kind) || c.widthM < rule.minWidth) return;
      // lights sit on the carriageway side of the belt, everything else centred
      const t = kind === 'streetlight' ? (i <= e.section!.components.length / 2 ? 0.85 : 0.15) : 0.5;
      for (let s = from + rule.spacing / 2; s <= to; s += rule.spacing) {
        const clash = taken.some(
          (x) => x.edgeId === e.id && x.compIndex === i && Math.abs(x.stationM - s) < rule.spacing * 0.5,
        );
        if (!clash) {
          out.push({ kind, edgeId: e.id, stationM: s, compIndex: i, t, placedBy: 'suggest' });
        }
      }
    });
  }
  return out;
}

/** Zebra crossings at junction approaches: one per approach mouth, set back
 *  from the junction trim (IRC practice: crossing just behind the mouth). */
export function suggestZebras(
  g: GraphState,
  existing: StreetElement[],
  trims: Record<string, { start: number; end: number }>,
): Array<Omit<StreetElement, 'id'>> {
  const out: Array<Omit<StreetElement, 'id'>> = [];
  const crossings = existing.filter((e) => e.kind === 'zebra' || e.kind === 'raisedcrossing');
  const deg: Record<string, number> = {};
  for (const e of Object.values(g.edges)) {
    deg[e.a] = (deg[e.a] ?? 0) + 1;
    deg[e.b] = (deg[e.b] ?? 0) + 1;
  }
  const W = DEFAULT_WIDTH.zebra!;
  const SETBACK = 2.5; // mouth → near edge of the crossing
  for (const e of Object.values(g.edges)) {
    if (!e.section || !drivableSpan(e.section)) continue;
    const L = polylineLength(e.points);
    const cands: number[] = [];
    if ((deg[e.a] ?? 0) >= 3) cands.push((trims[e.id]?.start ?? 0) + SETBACK + W / 2);
    if ((deg[e.b] ?? 0) >= 3) cands.push(L - (trims[e.id]?.end ?? 0) - SETBACK - W / 2);
    for (const s of cands) {
      if (s < 1 || s > L - 1) continue;
      const clash = crossings.some((x) => x.edgeId === e.id && Math.abs(x.stationM - s) < 8);
      if (!clash) {
        out.push({ kind: 'zebra', edgeId: e.id, stationM: s, compIndex: -1, t: 0.5, widthM: W, placedBy: 'suggest' });
      }
    }
  }
  return out;
}

/** Bus stops seeded from the OSM bus-stop nodes in the last download. */
export function suggestBusStops(
  g: GraphState,
  stops: Array<{ x: number; y: number }>,
  existing: StreetElement[],
): Array<Omit<StreetElement, 'id'>> {
  const out: Array<Omit<StreetElement, 'id'>> = [];
  const taken = existing.filter((e) => e.kind === 'busstop');
  for (const p of stops) {
    const place = resolveDrop(g, 'busstop', p.x, p.y, 30);
    if (!place) continue;
    const clash = [...taken, ...out].some(
      (x) => x.edgeId === place.edgeId && Math.abs(x.stationM - place.stationM) < 15,
    );
    if (!clash) out.push({ kind: 'busstop', ...place, placedBy: 'suggest' });
  }
  return out;
}

/** Whether an element's anchor still exists (edge present, component in range). */
export function isElementValid(edge: StreetEdge | undefined, el: StreetElement): boolean {
  if (!edge?.section) return false;
  if (el.kind === 'zebra' || el.kind === 'raisedcrossing') return !!drivableSpan(edge.section);
  return el.compIndex >= 0 && el.compIndex < edge.section.components.length;
}

/** Drop elements whose anchors a graph mutation invalidated. */
export function pruneElements(
  g: GraphState,
  elements: Record<string, StreetElement>,
): Record<string, StreetElement> {
  let changed = false;
  const out: Record<string, StreetElement> = {};
  for (const [id, el] of Object.entries(elements)) {
    if (isElementValid(g.edges[el.edgeId], el)) out[id] = el;
    else changed = true;
  }
  return changed ? out : elements;
}
