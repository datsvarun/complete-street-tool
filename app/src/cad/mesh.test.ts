import { describe, expect, it } from 'vitest';
import { weldMapFor, weldedDragDeltas } from './mesh';
import { applyShapeOverrides } from './vertexOverrides';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import { buildEdgeGeometry } from '../sections/transition';
import type { GraphState } from '../types';
import type { VertexOverrides } from './vertexOverrides';

// straight street, footpath | carriageway | footpath — adjacent bands share
// their long boundaries vertex-for-vertex
const g: GraphState = {
  nodes: {
    n1: { id: 'n1', x: 0, y: 0 },
    n2: { id: 'n2', x: 80, y: 0 },
  },
  edges: {
    e1: {
      id: 'e1',
      a: 'n1',
      b: 'n2',
      points: [0, 0, 80, 0],
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

function bandShapes() {
  const artifacts = deriveNodeArtifactsCached(g, {});
  const { bands } = buildEdgeGeometry(g.edges.e1, artifacts.trims.e1);
  return { artifacts, bands };
}

describe('welded mesh', () => {
  it('welds the carriageway boundary vertices to the footpath bands', () => {
    const { artifacts, bands } = bandShapes();
    const cw = bands.find((b) => b.key.includes('Carriageway'))!;
    const weld = weldMapFor(g, artifacts, `band:e1:${cw.key}`);
    expect(weld).toHaveLength(cw.polygon.length / 2);
    // every carriageway vertex lies on a footpath boundary → welded
    const weldedCount = weld.filter((m) => m.length > 0).length;
    expect(weldedCount).toBe(weld.length);
    // members reference footpath band shapes
    const memberKeys = new Set(weld.flat().map((m) => m.shapeKey));
    expect([...memberKeys].every((k) => k.startsWith('band:e1:'))).toBe(true);
    expect(memberKeys.size).toBeGreaterThanOrEqual(2);
  });

  it('a welded drag lands every member shape on the same world point', () => {
    const { artifacts, bands } = bandShapes();
    const cw = bands.find((b) => b.key.includes('Carriageway'))!;
    const targetKey = `band:e1:${cw.key}`;
    const weld = weldMapFor(g, artifacts, targetKey);
    const i = weld.findIndex((m) => m.length > 0);
    const target = { x: cw.polygon[i * 2] + 1.5, y: cw.polygon[i * 2 + 1] - 0.8 };

    const entries = weldedDragDeltas(targetKey, cw.polygon, weld, {}, i, target.x, target.y);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const overrides: VertexOverrides = {};
    for (const e of entries) {
      overrides[e.shapeKey] = { ...overrides[e.shapeKey], [e.key]: e.delta };
    }
    // target shape vertex lands on the drag point
    const moved = applyShapeOverrides(cw.polygon, overrides[targetKey]);
    expect(moved[i * 2]).toBeCloseTo(target.x, 4);
    expect(moved[i * 2 + 1]).toBeCloseTo(target.y, 4);
    // and every welded member lands on the SAME point (no tearing)
    for (const m of weld[i]) {
      const mMoved = applyShapeOverrides(m.basePolygon, overrides[m.shapeKey]);
      expect(mMoved[m.vertexIndex * 2]).toBeCloseTo(target.x, 4);
      expect(mMoved[m.vertexIndex * 2 + 1]).toBeCloseTo(target.y, 4);
    }
  });

  it('meshEdit off (empty weld map) touches only the target shape', () => {
    const { bands } = bandShapes();
    const cw = bands.find((b) => b.key.includes('Carriageway'))!;
    const entries = weldedDragDeltas(`band:e1:${cw.key}`, cw.polygon, [], {}, 0, 1, 1);
    expect(entries).toHaveLength(1);
  });
});
