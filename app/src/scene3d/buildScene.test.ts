import { describe, expect, it } from 'vitest';
import { buildScene } from './buildScene';
import type { GraphState, StreetElement } from '../types';

const g: GraphState = {
  nodes: {
    n1: { id: 'n1', x: 0, y: 0 },
    n2: { id: 'n2', x: 100, y: 0 },
  },
  edges: {
    e1: {
      id: 'e1',
      a: 'n1',
      b: 'n2',
      points: [0, 0, 100, 0],
      section: {
        catalogId: null,
        components: [
          { element: 'Footpath', widthM: 2, kind: 'footpath' },
          { element: 'Carriageway', widthM: 7, kind: 'carriageway' },
          { element: 'Footpath', widthM: 2, kind: 'footpath' },
        ],
      },
    },
  },
  nextNodeNum: 3,
  nextEdgeNum: 2,
};

const tree: StreetElement = { id: 'x1', kind: 'tree', edgeId: 'e1', stationM: 50, compIndex: 0, t: 0.5 };

describe('buildScene', () => {
  it('extrudes one prism per band with kerb heights above the road', () => {
    const spec = buildScene(g, {}, [tree]);
    const bands = spec.prisms.filter((p) => p.key.startsWith('band:'));
    expect(bands).toHaveLength(3);
    const road = bands.find((p) => p.key.includes('Carriageway'))!;
    const walk = bands.find((p) => p.key.includes('Footpath'))!;
    expect(road.height).toBeLessThan(walk.height); // kerb upstand
    expect(walk.height - road.height).toBeCloseTo(0.15, 2);
    expect(spec.bounds).not.toBeNull();
  });

  it('turns trees into posts positioned inside their band', () => {
    const spec = buildScene(g, {}, [tree]);
    expect(spec.posts).toHaveLength(1);
    const p = spec.posts[0];
    expect(p.kind).toBe('tree');
    // footpath is the leftmost band: offset ≈ +4.5±1 m from the centerline (y-down left normal)
    expect(Math.abs(p.y)).toBeGreaterThan(3.4);
    expect(Math.abs(p.y)).toBeLessThan(5.6);
  });

  it('applies CAD vertex overrides to the extruded footprints', () => {
    const base = buildScene(g, {}, []);
    const key = base.prisms[0].key;
    const withOv = buildScene(g, {}, [], [], { [key]: { '0.0000': { a: 0, c: 2 } } });
    expect(withOv.prisms[0].polygon).not.toEqual(base.prisms[0].polygon);
  });
});
