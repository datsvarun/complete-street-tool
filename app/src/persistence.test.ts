import { describe, expect, it } from 'vitest';
import { DOC_VERSION, fromDocument, toDocument } from './persistence';
import type { DocumentSlice } from './persistence';

const slice: DocumentSlice = {
  origin: { lat: 18.5, lon: 73.8 },
  nodes: {
    n1: { id: 'n1', x: 0, y: 0 },
    n2: { id: 'n2', x: 50, y: 0 },
  },
  edges: {
    e1: { id: 'e1', a: 'n1', b: 'n2', points: [0, 0, 50, 0], section: null },
  },
  nextNodeNum: 3,
  nextEdgeNum: 2,
  junctionDesigns: {},
  elements: { x1: { id: 'x1', kind: 'tree', edgeId: 'e1', stationM: 10, compIndex: 0, t: 0.5 } },
  nextElementNum: 2,
  patches: {},
  nextPatchNum: 1,
  boundaries: { b1: { id: 'b1', points: [0, 0, 10, 2, 20, -1] } },
  nextBoundaryNum: 2,
  vertexOverrides: { 'band:e1:c0-band': { '0.2500': { a: 0.5, c: -1 } } },
  meshEdits: { 'band:e1:c0-band@0.2500': { dx: 0.5, dy: -1 } },
  busStops: [{ x: 5, y: 5, name: 'Stop A' }],
};

describe('document round-trip', () => {
  it('serializes and loads back identically', () => {
    const doc = toDocument(slice);
    expect(doc.version).toBe(DOC_VERSION);
    const back = fromDocument(JSON.parse(JSON.stringify(doc)));
    expect(back).toEqual(slice);
  });

  it('rejects non-documents and newer versions', () => {
    expect(typeof fromDocument(null)).toBe('string');
    expect(typeof fromDocument({ foo: 1 })).toBe('string');
    expect(typeof fromDocument({ app: 'cst', version: DOC_VERSION + 1 })).toBe('string');
  });

  it('rejects a graph with dangling edge endpoints', () => {
    const doc = toDocument(slice);
    const broken = JSON.parse(JSON.stringify(doc));
    delete broken.nodes.n2;
    expect(typeof fromDocument(broken)).toBe('string');
  });

  it('defaults missing overlay fields (forward-compatible loader)', () => {
    const doc = toDocument(slice) as unknown as Record<string, unknown>;
    delete doc.elements;
    delete doc.busStops;
    delete doc.nextElementNum;
    const back = fromDocument(doc);
    expect(back).not.toBeTypeOf('string');
    if (typeof back !== 'string') {
      expect(back.elements).toEqual({});
      expect(back.busStops).toEqual([]);
    }
  });
});
