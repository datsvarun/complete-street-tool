import type { ComponentKind, EdgeSection, SectionComponent } from '../types';
import { dedupe, offsetPolyline, ribbonBand, toFlat, toPts } from './polyline';
import type { Pt } from './polyline';
import { boundaryMarking } from '../sections/markings';

export interface RibbonBand {
  key: string;
  element: string;
  kind: ComponentKind;
  widthM: number;
  polygon: number[]; // flat closed polygon, metres
}

export interface RibbonMarking {
  key: string;
  dashed: boolean; // from the pair rules in sections/markings.ts
  line: number[];  // flat polyline, metres
}

/** Fraction of the section width lying LEFT of the drawn centerline. */
export function refFraction(section: Pick<EdgeSection, 'components' | 'refM'>): number {
  const total = section.components.reduce((s, c) => s + c.widthM, 0);
  if (total < 1e-6) return 0.5;
  const ref = section.refM ?? total / 2;
  return Math.max(0, Math.min(1, ref / total));
}

/**
 * Derive one polygon per section component, side by side across the centerline,
 * plus lane markings where the pair rules call for one.
 * Components run left → right; `refF` decides where the centerline sits.
 * Fully derived from (edge points, components, align) — safe to regenerate on
 * any edit (Plan v2 §1.2).
 */
export function buildRibbon(
  edgePoints: number[],
  components: SectionComponent[],
  refF = 0.5,
): { bands: RibbonBand[]; markings: RibbonMarking[] } {
  const pts: Pt[] = dedupe(toPts(edgePoints));
  if (pts.length < 2) return { bands: [], markings: [] };
  const total = components.reduce((s, c) => s + c.widthM, 0);
  const bands: RibbonBand[] = [];
  const markings: RibbonMarking[] = [];
  let offset = total * refF; // left edge of the first component
  components.forEach((c, i) => {
    bands.push({
      key: `${i}-${c.element}`,
      element: c.element,
      kind: c.kind,
      widthM: c.widthM,
      polygon: ribbonBand(pts, offset, offset - c.widthM),
    });
    if (i > 0) {
      const style = boundaryMarking(components[i - 1].kind, c.kind);
      if (style) {
        markings.push({
          key: `m${i}`,
          dashed: style === 'dashed',
          line: toFlat(offsetPolyline(pts, offset)),
        });
      }
    }
    offset -= c.widthM;
  });
  return { bands, markings };
}
