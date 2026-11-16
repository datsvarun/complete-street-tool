// Transition engine (Plan v2 §3.2): where an edge's section changes (override
// boundaries), components are matched by kind, taper lengths derive from
// per-kind ratios, and boundary offsets blend with smoothstep — tangent-
// continuous entry/exit, no arc fitting. Fully derived: recomputed on every
// render, never stored (Plan v2 §1.2).
import type { ComponentKind, EdgeSection, SectionComponent, StreetEdge } from '../types';
import { pointAtStation, polylineLength, subPolyline } from '../geometry/polyline';
import type { RibbonBand, RibbonMarking } from '../geometry/ribbon';
import { buildRibbon, refFraction } from '../geometry/ribbon';

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

/** A matching unit: one component, or a carriageway group `cw (median cw)*`
 *  that must transition as a whole (so divided↔single merges properly). */
interface MatchToken {
  kind: string; // ComponentKind or 'cwgroup'
  comps: SectionComponent[];
}

function tokenize(s: SectionComponent[]): MatchToken[] {
  const out: MatchToken[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i].kind === 'carriageway') {
      const grp = [s[i]];
      let j = i + 1;
      while (j + 1 < s.length && s[j].kind === 'median' && s[j + 1].kind === 'carriageway') {
        grp.push(s[j], s[j + 1]);
        j += 2;
      }
      out.push({ kind: 'cwgroup', comps: grp });
      i = j;
    } else {
      out.push({ kind: s[i].kind, comps: [s[i]] });
      i++;
    }
  }
  return out;
}

const tokenW = (t: MatchToken) => t.comps.reduce((s, c) => s + c.widthM, 0);

/** Aligned entries for two matched carriageway groups. Equal carriageway
 *  counts pair off positionally; a multi-carriageway group meeting a single
 *  carriageway splits the single width proportionally so both carriageways
 *  converge while the median pinches out (a Y-merge, not a taper-to-edge). */
function positionalPair(a: SectionComponent[], b: SectionComponent[]): MatchedComponent[] {
  const out: MatchedComponent[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = a[i] ?? b[i];
    out.push({ element: c.element, kind: c.kind, w1: a[i]?.widthM ?? 0, w2: b[i]?.widthM ?? 0 });
  }
  return out;
}

function expandGroupPair(a: SectionComponent[], b: SectionComponent[]): MatchedComponent[] {
  const nA = a.filter((c) => c.kind === 'carriageway').length;
  const nB = b.filter((c) => c.kind === 'carriageway').length;
  if (nA === nB) return positionalPair(a, b);
  const manyIsA = nA > nB;
  const [many, few] = manyIsA ? [a, b] : [b, a];
  // multi-vs-multi with different counts — rare; plain positional fallback
  if (few.length !== 1) return positionalPair(a, b);
  const cwTotal = many.filter((c) => c.kind === 'carriageway').reduce((s, c) => s + c.widthM, 0);
  return many.map((c) => {
    const share = c.kind === 'carriageway' ? few[0].widthM * (c.widthM / cwTotal) : 0;
    return {
      element: c.element,
      kind: c.kind,
      w1: manyIsA ? c.widthM : share,
      w2: manyIsA ? share : c.widthM,
    };
  });
}

/**
 * Match components of two sections (Plan v2 §3.2.1): width-weighted LCS over
 * kind tokens — maximising Σ min(w1, w2) keeps the widest components
 * continuous and makes A→B mirror B→A (an unweighted LCS breaks ties
 * asymmetrically, so a reordered cycle track tapered out at one node but slid
 * across the footpath at the next). Matched pairs taper, unmatched
 * from-components drop, unmatched to-components are introduced — merged into
 * one ordered timeline.
 */
export function matchComponents(s1: SectionComponent[], s2: SectionComponent[]): MatchedComponent[] {
  const t1 = tokenize(s1);
  const t2 = tokenize(s2);
  const n = t1.length, m = t2.length;
  const MATCH_BONUS = 0.01; // matching beats not matching even at zero width
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(dp[i + 1][j], dp[i][j + 1]);
      if (t1[i].kind === t2[j].kind) {
        best = Math.max(best, Math.min(tokenW(t1[i]), tokenW(t2[j])) + MATCH_BONUS + dp[i + 1][j + 1]);
      }
      dp[i][j] = best;
    }
  }
  const out: MatchedComponent[] = [];
  const dropTok = (t: MatchToken) =>
    out.push(...t.comps.map((c) => ({ element: c.element, kind: c.kind, w1: c.widthM, w2: 0 })));
  const introTok = (t: MatchToken) =>
    out.push(...t.comps.map((c) => ({ element: c.element, kind: c.kind, w1: 0, w2: c.widthM })));
  let i = 0, j = 0;
  const EPS = 1e-9;
  while (i < n || j < m) {
    if (
      i < n && j < m && t1[i].kind === t2[j].kind &&
      Math.abs(dp[i][j] - (Math.min(tokenW(t1[i]), tokenW(t2[j])) + MATCH_BONUS + dp[i + 1][j + 1])) < EPS
    ) {
      if (t1[i].kind === 'cwgroup') out.push(...expandGroupPair(t1[i].comps, t2[j].comps));
      else out.push({ element: t1[i].comps[0].element, kind: t1[i].comps[0].kind, w1: tokenW(t1[i]), w2: tokenW(t2[j]) });
      i++; j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      dropTok(t1[i]);
      i++;
    } else {
      introTok(t2[j]);
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
 * Sample smoothstep-blended component polygons along `path` between stations
 * [from, to] (§3.2.3). Shared by mid-edge overrides and node transitions.
 */
export function sampleTransitionBands(
  path: number[],
  matched: MatchedComponent[],
  from: number,
  to: number,
  keyPrefix: string,
  alignF1 = 0.5,
  alignF2 = 0.5,
): RibbonBand[] {
  const zoneLen = to - from;
  if (zoneLen < 0.05) return [];
  const bands: RibbonBand[] = [];
  const nSamples = Math.max(4, Math.ceil(zoneLen / SAMPLE_STEP_M) + 1);
  const stations: number[] = [];
  for (let k = 0; k < nSamples; k++) stations.push(from + (zoneLen * k) / (nSamples - 1));
  const samplePts = stations.map((s) => pointAtStation(path, s));
  const blend = stations.map((s) => smoothstep((s - from) / zoneLen));

  // Per-sample cumulative offsets; the alignment factor (share of width left
  // of the centerline) blends between the two sections' alignments.
  const widths = (ci: number, k: number) =>
    matched[ci].w1 + (matched[ci].w2 - matched[ci].w1) * blend[k];
  const totals = stations.map((_, k) => matched.reduce((sum, _c, ci) => sum + widths(ci, k), 0));

  let upper = stations.map((_, k) => totals[k] * (alignF1 + (alignF2 - alignF1) * blend[k]));
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
        key: `${keyPrefix}-t${ci}-${c.element}`,
        element: c.element,
        kind: c.kind,
        widthM: (c.w1 + c.w2) / 2,
        polygon: poly,
      });
    }
    upper = lower;
  });
  return bands;
}

/**
 * Full edge geometry: constant spans render via exact sub-polyline offsets,
 * transition spans sample smoothstep-blended boundaries (§3.2.3).
 * `trim` clips the ends (junction polygons / node transitions own that space).
 */
export function buildEdgeGeometry(
  edge: StreetEdge,
  trim?: { start: number; end: number },
): { bands: RibbonBand[]; markings: RibbonMarking[] } {
  let spans = spansForEdge(edge);
  if (!spans) return { bands: [], markings: [] };
  const L = polylineLength(edge.points);
  const t0 = trim?.start ?? 0;
  const t1 = L - (trim?.end ?? 0);
  if (t0 > 0 || t1 < L) {
    spans = spans
      .map((s) => ({ ...s, from: Math.max(s.from, t0), to: Math.min(s.to, t1) }))
      .filter((s) => s.to - s.from > 0.05);
  }
  const bands: RibbonBand[] = [];
  const markings: RibbonMarking[] = [];

  spans.forEach((span, si) => {
    if (span.kind === 'constant') {
      const sub = span.from < 0.01 && span.to > L - 0.01
        ? edge.points
        : subPolyline(edge.points, span.from, span.to);
      if (sub.length < 4) return;
      const r = buildRibbon(sub, span.sec!.components, refFraction(span.sec!));
      r.bands.forEach((b) => bands.push({ ...b, key: `s${si}-${b.key}` }));
      r.markings.forEach((m) => markings.push({ ...m, key: `s${si}-${m.key}` }));
      return;
    }
    const f = edge.section ? refFraction(edge.section) : 0.5;
    bands.push(...sampleTransitionBands(edge.points, span.matched!, span.from, span.to, `s${si}`, f, f));
  });

  return { bands, markings };
}

