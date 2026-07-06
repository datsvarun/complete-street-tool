// Stage 2 section rules: auto-assignment defaults, citable minimum widths,
// and the Streetmix resolution-per-interaction width normalizer
// (Plan v2 §3.1/§3.3, Case_Study §2.1–2.3).
import type { ComponentKind, CrossSection, EdgeSection, GraphState, ReviewItem } from '../types';
import { CATALOG } from '../catalog';

/** highway=* → target IRC ROW class (defaults table, Plan v2 §3.3). */
export const HIGHWAY_TO_ROW: Record<string, number> = {
  motorway: 60,
  trunk: 45,
  primary: 30,
  secondary: 24,
  tertiary: 18,
  unclassified: 12,
  residential: 12,
  living_street: 9,
  service: 9,
  pedestrian: 7.5,
};

/**
 * Minimum component widths, metres. Numbers follow Plan v2 §3.1 and are marked
 * (verify) until checked against the source documents (Plan v2 §9.3) — the
 * validator treats them as warnings, never blockers (Case_Study §2.3).
 */
export const COMPONENT_MINS: Partial<Record<ComponentKind, { minM: number; source: string }>> = {
  footpath: { minM: 1.8, source: 'IRC:103-2012 (verify)' },
  cycle: { minM: 2.0, source: 'IRC SP:118-2018 (verify)' },
  carriageway: { minM: 3.0, source: 'IRC SP:118-2018 — one lane (verify)' },
  mixed: { minM: 3.0, source: 'IRC SP:118-2018 (verify)' },
  muz: { minM: 1.0, source: 'IRC SP:118-2018 (verify)' },
  mfz: { minM: 1.0, source: 'IRC SP:118-2018 (verify)' },
  median: { minM: 0.6, source: 'IRC SP:118-2018 (verify)' },
  buffer: { minM: 0.5, source: 'IRC SP:118-2018 (verify)' },
  parking: { minM: 2.0, source: 'IRC SP:118-2018 (verify)' },
  service: { minM: 3.0, source: 'IRC SP:118-2018 (verify)' },
};

/** Palette defaults when adding a component in the strip editor. */
export const COMPONENT_DEFAULTS: Array<{ kind: ComponentKind; element: string; widthM: number }> = [
  { kind: 'footpath', element: 'Footpath', widthM: 2.5 },
  { kind: 'carriageway', element: 'Carriageway', widthM: 3.5 },
  { kind: 'mixed', element: 'Mixed traffic lane', widthM: 3.5 },
  { kind: 'cycle', element: 'Cycle Track', widthM: 2.0 },
  { kind: 'muz', element: 'MUZ', widthM: 1.5 },
  { kind: 'mfz', element: 'MFZ', widthM: 2.0 },
  { kind: 'buffer', element: 'Buffer', widthM: 1.0 },
  { kind: 'median', element: 'Median', widthM: 1.0 },
  { kind: 'parking', element: 'Parking', widthM: 2.0 },
  { kind: 'tree', element: 'Tree Line', widthM: 1.5 },
  { kind: 'busstop', element: 'Bus Stop / MFZ', widthM: 2.0 },
];

export const WIDTH_MIN = 0.3;
export const WIDTH_MAX = 30;
export const RES_TYPING = 0.05; // Case_Study §2.1: finer snap for explicit input
export const RES_CLICK = 0.1;   // +/- buttons and dragging

export function normalizeWidth(w: number, resolution: number): number {
  if (!Number.isFinite(w)) return WIDTH_MIN;
  const clamped = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
  return Math.round(Math.round(clamped / resolution) * resolution * 1000) / 1000;
}

export function materialize(section: CrossSection): EdgeSection {
  return {
    catalogId: section.id,
    components: section.components.map((c) => ({ ...c })),
  };
}

function pickSectionForRow(rowM: number, preferMedian: boolean): CrossSection | null {
  const group = CATALOG.filter((s) => s.rowWidthM === rowM);
  if (group.length === 0) return null;
  if (preferMedian) {
    const withMedian = group.find((s) => s.components.some((c) => c.kind === 'median'));
    if (withMedian) return withMedian;
  }
  return group[0];
}

export interface AutoAssignResult {
  assigned: Record<string, EdgeSection>; // edgeId → section
  review: ReviewItem[];
}

/**
 * Auto-section assignment on entry to Stage 2 (Plan v2 §3.3): map highway class
 * to an IRC ROW group, pick the best catalog config, and queue a review list of
 * low-confidence edges instead of interrupting the user.
 */
export function autoAssignSections(g: GraphState): AutoAssignResult {
  const assigned: Record<string, EdgeSection> = {};
  const review: ReviewItem[] = [];
  for (const e of Object.values(g.edges)) {
    if (e.section) continue; // never overwrite existing work
    const base = e.highway?.replace(/_link$/, '');
    if (!base) {
      review.push({ edgeId: e.id, reason: 'no highway class — assign manually' });
      continue;
    }
    const rowM = HIGHWAY_TO_ROW[base];
    if (rowM === undefined) {
      review.push({ edgeId: e.id, reason: `unmapped class “${e.highway}” — assign manually` });
      continue;
    }
    const divided = e.carriagewayType === 'divided';
    const section = pickSectionForRow(rowM, divided);
    if (!section) {
      review.push({ edgeId: e.id, reason: `no catalog section for ${rowM} m ROW` });
      continue;
    }
    assigned[e.id] = materialize(section);
    if (e.highway?.endsWith('_link')) {
      review.push({ edgeId: e.id, reason: `link road — check ${rowM} m ROW fits` });
    } else if (divided && !section.components.some((c) => c.kind === 'median')) {
      review.push({ edgeId: e.id, reason: 'divided carriageway but section has no median' });
    }
  }
  return { assigned, review };
}
