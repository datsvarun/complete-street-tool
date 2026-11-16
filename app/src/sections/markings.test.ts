import { describe, expect, it } from 'vitest';
import { boundaryMarking } from './markings';
import { buildRibbon } from '../geometry/ribbon';
import type { SectionComponent } from '../types';

describe('boundaryMarking pair rules', () => {
  it('dashes between lanes of the same kind, solid between different drivable kinds', () => {
    expect(boundaryMarking('carriageway', 'carriageway')).toBe('dashed');
    expect(boundaryMarking('carriageway', 'mixed')).toBe('solid');
    expect(boundaryMarking('brt', 'carriageway')).toBe('solid');
  });

  it('is symmetric', () => {
    expect(boundaryMarking('cycle', 'carriageway')).toBe(boundaryMarking('carriageway', 'cycle'));
    expect(boundaryMarking('parking', 'mixed')).toBe(boundaryMarking('mixed', 'parking'));
  });

  it('draws an edge line beside a cycle lane or buffer, none beside parking or a kerb', () => {
    expect(boundaryMarking('cycle', 'carriageway')).toBe('solid');
    expect(boundaryMarking('buffer', 'carriageway')).toBe('solid');
    expect(boundaryMarking('parking', 'carriageway')).toBeNull();
    expect(boundaryMarking('footpath', 'carriageway')).toBeNull();
    expect(boundaryMarking('median', 'carriageway')).toBeNull();
  });
});

describe('buildRibbon markings', () => {
  it('places one marking per ruled boundary', () => {
    const comps: SectionComponent[] = [
      { element: 'Footpath', kind: 'footpath', widthM: 2 },
      { element: 'Cycle Track', kind: 'cycle', widthM: 2 },
      { element: 'Carriageway', kind: 'carriageway', widthM: 3.5 },
      { element: 'Carriageway', kind: 'carriageway', widthM: 3.5 },
      { element: 'Parking', kind: 'parking', widthM: 2 },
    ];
    const { markings } = buildRibbon([0, 0, 50, 0], comps);
    expect(markings.map((m) => [m.key, m.dashed])).toEqual([
      ['m2', false], // cycle | carriageway
      ['m3', true],  // carriageway | carriageway
    ]);
  });
});
