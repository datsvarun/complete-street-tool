// Transition engine (Plan v2 §3.2): where an edge's section changes (override
// boundaries), components are matched by kind, taper lengths derive from
// per-kind ratios, and boundary offsets blend with smoothstep — tangent-
// continuous entry/exit, no arc fitting. Fully derived: recomputed on every
// render, never stored (Plan v2 §1.2).
import type { ComponentKind, EdgeSection, SectionComponent, StreetEdge } from '../types';
import { pointAtStation, polylineLength, subPolyline } from '../geometry/polyline';
import type { RibbonBand, RibbonMarking } from '../geometry/ribbon';
import { buildRibbon } from '../geometry/ribbon';

/** Taper ratios (length per metre of width change), Plan v2 §3.2.2. */
const TAPER_RATIO: Partial<Record<ComponentKind, number>> = {
  carriageway: 10, // 1:10 urban, IRC-consistent for ≤50 km/h
  mixed: 10,
  service: 10,
  brt: 10,
  median: 10,
};
const TAPER_RATIO_DEFAULT = 4; // footpath/landscape: visual, not vehicular

const MIN_TRANSITION_M = 3;
const SAMPLE_STEP_M = 2;

export interface MatchedComponent {
  element: string;
  kind: ComponentKind;
  w1: number; // width in the from-section (0 = introduced)
  w2: number; // width in the to-section (0 = dropped)
}

/**
 * Match components of two sections by kind (LCS over the kind sequence, which
 * approximates curb-inward ordered matching): matched pairs taper, unmatched
 * from-components drop, unmatched to-components are introduced — merged into
 * one ordered timeline (Plan v2 §3.2.1).
 */
export function matchComponents(s1: SectionComponent[], s2: SectionComponent[]): MatchedComponent[] {
  const n = s1.length, m = s2.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        s1[i].kind === s2[j].kind
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: MatchedComponent[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && s1[i].kind === s2[j].kind && lcs[i][j] === lcs[i + 1][j + 1] + 1) {
      out.push({ element: s1[i].element, kind: s1[i].kind, w1: s1[i].widthM, w2: s2[j].widthM });
      i++; j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ element: s1[i].element, kind: s1[i].kind, w1: s1[i].widthM, w2: 0 }); // drop
      i++;
    } else {
      out.push({ element: s2[j].element, kind: s2[j].kind, w1: 0, w2: s2[j].widthM }); // introduce
      j++;
    }
  }
  return out;
}

/** Transition zone length = max per-component taper, clamped (Plan v2 §3.2.2). */
export function transitionLength(matched: MatchedComponent[], maxAvailable: number): number {
  let L = MIN_TRANSITION_M;
  for (const c of matched) {
    const ratio = TAPER_RATIO[c.kind] ?? TAPER_RATIO_DEFAULT;
    L = Math.max(L, Math.abs(c.w2 - c.w1) * ratio);
  }
  return Math.max(MIN_TRANSITION_M, Math.min(L, maxAvailable));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

interface Span {
  from: number;
  to: number;
  kind: 'constant' | 'transition';
  sec?: EdgeSection;              // constant
  matched?: MatchedComponent[];   // transition
}

/** Resolve base + overrides + derived transition zones into an ordered span list. */
function spansForEdge(edge: StreetEdge): Span[] | null {
  const base = edge.section;
  if (!base) return null;
  const L = polylineLength(edge.points);
  const overrides = (edge.overrides ?? [])
    .filter((o) => o.toM - o.fromM > 1)
    .slice()
    .sort((a, b) => a.fromM - b.fromM);
  if (overrides.length === 0) return [{ from: 0, to: L, kind: 'constant', sec: base }];

  // Constant spans: base | ov1 | base | ov2 … then carve transition zones
  // symmetrically around each internal boundary.
  const constants: Array<{ from: number; to: number; sec: EdgeSection }> = [];
  let cursor = 0;
  for (const o of overrides) {
    const f = Math.max(0, Math.min(o.fromM, L));
    const t = Math.max(0, Math.min(o.toM, L));
    if (f > cursor) constants.push({ from: cursor, to: f, sec: base });
    constants.push({ from: f, to: t, sec: o.section });
    cursor = t;
  }
  if (cursor < L) constants.push({ from: cursor, to: L, sec: base });

  const spans: Span[] = [];
  for (let k = 0; k < constants.length; k++) {
    const cur = { ...constants[k] };
    const prev = spans[spans.length - 1];
    if (prev?.kind === 'transition') cur.from = prev.to;
    spans.push({ ...cur, kind: 'constant' });
    const next = constants[k + 1];
    if (!next) continue;
    const matched = matchComponents(cur.sec!.components, next.sec.components);
    const avail = Math.min((cur.to - cur.from) * 0.9, (next.to - next.from) * 0.9);
    const Lt = transitionLength(matched, Math.max(MIN_TRANSITION_M, avail));
    const b = cur.to;
    const zFrom = Math.max(cur.from, b - Lt / 2);
    const zTo = Math.min(next.to, b + Lt / 2);
    (spans[spans.length - 1] as Span).to = zFrom;
    spans.push({ from: zFrom, to: zTo, kind: 'transition', matched });
  }
  return spans.filter((s) => s.to - s.from > 0.05);
}

/**
 * Full edge geometry: constant spans render via exact sub-polyline offsets,
 * transition spans sample smoothstep-blended boundaries (§3.2.3). Carriageway
 * centerline holds position — the section stays centered (align: 'center').
 */
export function buildEdgeGeometry(edge: StreetEdge): { bands: RibbonBand[]; markings: RibbonMarking[] } {
  const spans = spansForEdge(edge);
  if (!spans) return { bands: [], markings: [] };
  const L = polylineLength(edge.points);
  const bands: RibbonBand[] = [];
  const markings: RibbonMarking[] = [];

  spans.forEach((span, si) => {
    if (span.kind === 'constant') {
      const sub = span.from < 0.01 && span.to > L - 0.01
        ? edge.points
        : subPolyline(edge.points, span.from, span.to);
      if (sub.length < 4) return;
      const r = buildRibbon(sub, span.sec!.components);
      r.bands.forEach((b) => bands.push({ ...b, key: `s${si}-${b.key}` }));
      r.markings.forEach((m) => markings.push({ ...m, key: `s${si}-${m.key}` }));
      return;
    }

    // Transition zone: sampled blended offsets.
    const matched = span.matched!;
    const zoneLen = span.to - span.from;
    const nSamples = Math.max(4, Math.ceil(zoneLen / SAMPLE_STEP_M) + 1);
    const stations: number[] = [];
    for (let k = 0; k < nSamples; k++) stations.push(span.from + (zoneLen * k) / (nSamples - 1));
    const samplePts = stations.map((s) => pointAtStation(edge.points, s));
    const blend = stations.map((s) => smoothstep((s - span.from) / zoneLen));

    // Per-sample cumulative offsets, centered on the total width at that sample.
    const widths = (ci: number, k: number) =>
      matched[ci].w1 + (matched[ci].w2 - matched[ci].w1) * blend[k];
    const totals = stations.map((_, k) =>
      matched.reduce((sum, _c, ci) => sum + widths(ci, k), 0),
    );

    let upper = stations.map((_, k) => totals[k] / 2);
    matched.forEach((c, ci) => {
      const lower = upper.map((u, k) => u - widths(ci, k));
      if (Math.max(...upper.map((u, k) => u - lower[k])) > 0.02) {
        const poly: number[] = [];
        for (let k = 0; k < nSamples; k++) {
          poly.push(samplePts[k].x + samplePts[k].nx * upper[k], samplePts[k].y + samplePts[k].ny * upper[k]);
        }
        for (let k = nSamples - 1; k >= 0; k--) {
          poly.push(samplePts[k].x + samplePts[k].nx * lower[k], samplePts[k].y + samplePts[k].ny * lower[k]);
        }
        bands.push({
          key: `s${si}-t${ci}-${c.element}`,
          element: c.element,
          kind: c.kind,
          widthM: (c.w1 + c.w2) / 2,
          polygon: poly,
        });
      }
      upper = lower;
    });
  });

  return { bands, markings };
}

