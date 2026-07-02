import type { CrossSection, ComponentKind } from '../types';
import { dedupe, ribbonBand, toPts } from './polyline';

export interface RibbonBand {
  key: string;
  element: string;
  kind: ComponentKind;
  widthM: number;
  polygon: number[]; // flat closed polygon, metres
}

/**
 * Derive one polygon per section component, side by side across the centerline.
 * Components run left → right; the section is centered on the centerline.
 * Fully derived from (edge points, section) — safe to regenerate on any edit (Plan v2 §1.2).
 */
export function buildRibbon(edgePoints: number[], section: CrossSection): RibbonBand[] {
  const pts = dedupe(toPts(edgePoints));
  if (pts.length < 2) return [];
  const bands: RibbonBand[] = [];
  let offset = section.totalWidthM / 2; // left edge of the first component
  section.components.forEach((c, i) => {
    bands.push({
      key: `${i}-${c.element}`,
      element: c.element,
      kind: c.kind,
      widthM: c.widthM,
      polygon: ribbonBand(pts, offset, offset - c.widthM),
    });
    offset -= c.widthM;
  });
  return bands;
}
