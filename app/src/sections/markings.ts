// Lane-line rules: the marking at a boundary is derived from the PAIR of
// components that meet there, never stored per component (Plan v2 §1.2).
// A pair lookup table with a few ordered overrides, using the IRC component
// vocabulary.
import type { ComponentKind } from '../types';

export type LineStyle = 'dashed' | 'solid';

/** Components vehicles drive on, at carriageway level. */
const DRIVABLE: ComponentKind[] = ['carriageway', 'mixed', 'service', 'brt'];

const pairKey = (a: ComponentKind, b: ComponentKind) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Unordered pair → line. Pairs not listed fall through to the defaults in
 *  `boundaryMarking`. `null` means "explicitly no line". */
const PAIR_RULES: Record<string, LineStyle | null> = {
  // Parking bays are marked by their own bay ticks, not a continuous line.
  [pairKey('parking', 'carriageway')]: null,
  [pairKey('parking', 'mixed')]: null,
  [pairKey('parking', 'service')]: null,
  // A cycle lane or painted buffer beside traffic gets a solid edge line.
  [pairKey('cycle', 'carriageway')]: 'solid',
  [pairKey('cycle', 'mixed')]: 'solid',
  [pairKey('cycle', 'service')]: 'solid',
  [pairKey('cycle', 'parking')]: 'solid',
  [pairKey('buffer', 'carriageway')]: 'solid',
  [pairKey('buffer', 'mixed')]: 'solid',
  [pairKey('buffer', 'service')]: 'solid',
  [pairKey('buffer', 'brt')]: 'solid',
};

/**
 * The line drawn where `left` meets `right`, or null for none.
 * Order: explicit pair rule → two drivable lanes (dashed between the same
 * kind, solid between different kinds) → nothing (kerbs draw themselves).
 */
export function boundaryMarking(left: ComponentKind, right: ComponentKind): LineStyle | null {
  const rule = PAIR_RULES[pairKey(left, right)];
  if (rule !== undefined) return rule;
  if (DRIVABLE.includes(left) && DRIVABLE.includes(right)) return left === right ? 'dashed' : 'solid';
  return null;
}
