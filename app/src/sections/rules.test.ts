import { describe, expect, it } from 'vitest';
import { autoAssignSections } from './rules';
import { getSection } from '../catalog';
import type { GraphState } from '../types';

function graphWith(highway: string): GraphState {
  return {
    nodes: {
      n1: { id: 'n1', x: 0, y: 0 },
      n2: { id: 'n2', x: 100, y: 0 },
    },
    edges: {
      e1: { id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 100, 0], section: null, highway },
    },
    nextNodeNum: 3,
    nextEdgeNum: 2,
  };
}

describe('autoAssignSections defaults', () => {
  it('assigns 12 m ROW Mixed street (2) to regular residential streets', () => {
    const { assigned } = autoAssignSections(graphWith('residential'));
    const section = assigned.e1;
    expect(section).toBeDefined();
    const cat = getSection(section.catalogId);
    expect(cat?.rowWidthM).toBe(12);
    expect(cat?.name).toMatch(/mixed street \(2\)/i);
  });

  it('still assigns the first config where no preference exists', () => {
    const { assigned } = autoAssignSections(graphWith('tertiary'));
    expect(getSection(assigned.e1.catalogId)?.rowWidthM).toBe(18);
  });
});
