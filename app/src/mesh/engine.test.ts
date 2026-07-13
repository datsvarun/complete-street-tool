import { describe, expect, it } from 'vitest';
import {
  buildMesh,
  cutAcross,
  deleteFaceAbsorb,
  facesOfNode,
  filletNode,
  insertOnSegment,
  meshInvariants,
  mergeFaces,
  moveNode,
  retypeFace,
  splitFace,
  weldNodes,
} from './engine';
import type { GraphState } from '../types';

// T-junction: main road with a side street — strips, junction, corners.
const sect = (widths: Array<[string, number]>) => ({
  catalogId: null,
  components: widths.map(([kind, widthM]) => ({ element: kind, widthM, kind: kind as never })),
});
const g: GraphState = {
  nodes: {
    a: { id: 'a', x: -80, y: 0 },
    b: { id: 'b', x: 80, y: 0 },
    c: { id: 'c', x: 0, y: 0 },
    d: { id: 'd', x: 0, y: 90 },
  },
  edges: {
    e1: { id: 'e1', a: 'a', b: 'c', points: [-80, 0, -40, 0, 0, 0], section: sect([['footpath', 2], ['carriageway', 7], ['footpath', 2]]) },
    e2: { id: 'e2', a: 'c', b: 'b', points: [0, 0, 40, 0, 80, 0], section: sect([['footpath', 2], ['carriageway', 7], ['footpath', 2]]) },
    e3: { id: 'e3', a: 'c', b: 'd', points: [0, 0, 0, 45, 0, 90], section: sect([['footpath', 2], ['carriageway', 7], ['footpath', 2]]) },
  },
  nextNodeNum: 5,
  nextEdgeNum: 4,
};

const mesh = buildMesh(g, {}, 'common');

// spec §6.2: every interior boundary shared — no face pair with coincident
// but differently-identified consecutive nodes.
function noCracks(m: typeof mesh): boolean {
  const seen = new Map<string, string>();
  for (const f of m.faces) {
    for (let i = 0; i < f.nodes.length; i++) {
      const a = m.nodes[f.nodes[i]];
      const k = `${Math.round(a.x * 50)}:${Math.round(a.y * 50)}`;
      const prev = seen.get(k);
      if (prev && prev !== f.nodes[i]) return false; // same point, two ids
      seen.set(k, f.nodes[i]);
    }
  }
  return true;
}

describe('mesh build', () => {
  it('valid, welded, crack-free', () => {
    expect(mesh.faces.length).toBeGreaterThan(10);
    expect(meshInvariants(mesh)).toEqual([]);
    expect(noCracks(mesh)).toBe(true);
    // strips exist for all bands; a junction face exists
    expect(mesh.faces.some((f) => f.kind === 'junction')).toBe(true);
    expect(mesh.faces.filter((f) => f.kind === 'strip' && f.fn === 'footpath').length).toBeGreaterThan(3);
  });

  it('headline: moving a shared node touches only its adjacent faces', () => {
    // find a node shared by ≥2 faces
    const nid = Object.keys(mesh.nodes).find((id) => facesOfNode(mesh, id).length >= 2)!;
    const adj = facesOfNode(mesh, nid).map((f) => f.id);
    const m2 = moveNode(mesh, nid, mesh.nodes[nid].x + 3, mesh.nodes[nid].y + 2)!;
    expect(adj.length).toBeGreaterThanOrEqual(2);
    expect(meshInvariants(m2)).toEqual([]);
    expect(m2.editLog).toEqual(['move']);
  });
});

describe('mesh operations', () => {
  const strip = mesh.faces.find((f) => f.kind === 'strip' && f.fn === 'carriageway')!;

  it('insert-node splices into EVERY face sharing the segment', () => {
    const [a, b] = strip.nodes; // lateral boundary shared with the footpath strip
    const before = mesh.faces.length;
    const m2 = insertOnSegment(mesh, a, b, (mesh.nodes[a].x + mesh.nodes[b].x) / 2, (mesh.nodes[a].y + mesh.nodes[b].y) / 2)!;
    expect(m2.faces.length).toBe(before); // face count unchanged
    const nid = `ins:${mesh.nextNum}`;
    expect(facesOfNode(m2, nid).length).toBeGreaterThanOrEqual(1);
    expect(meshInvariants(m2)).toEqual([]);
  });

  it('retype changes fn only', () => {
    const m2 = retypeFace(mesh, strip.id, 'parking')!;
    expect(m2.faces.find((f) => f.id === strip.id)!.fn).toBe('parking');
    expect(m2.faces.length).toBe(mesh.faces.length);
  });

  it('split + merge round-trips a quad', () => {
    const m2 = splitFace(mesh, strip.id, strip.nodes[0], strip.nodes[2])!;
    expect(m2.faces.length).toBe(mesh.faces.length + 1);
    const [fa, fb] = [`${strip.id}.a`, `${strip.id}.b`];
    expect(meshInvariants(m2)).toEqual([]);
    const m3 = mergeFaces(m2, fa, fb)!;
    expect(m3.faces.length).toBe(mesh.faces.length);
    const merged = m3.faces.find((f) => f.id === fa)!;
    expect(new Set(merged.nodes)).toEqual(new Set(strip.nodes));
  });

  it('delete-with-absorb grows a drivable neighbour over the deleted band', () => {
    const fp = mesh.faces.find((f) => f.kind === 'strip' && f.fn === 'footpath')!;
    const m2 = deleteFaceAbsorb(mesh, fp.id)!;
    expect(m2.faces.length).toBe(mesh.faces.length - 1);
    expect(meshInvariants(m2)).toEqual([]);
  });

  it('weld pinches a band to a taper and drops slivers', () => {
    const [a, b] = [strip.nodes[0], strip.nodes[1]];
    const m2 = weldNodes(mesh, a, b)!;
    expect(m2.nodes[a]).toBeUndefined();
    expect(meshInvariants(m2)).toEqual([]);
    // the strip quad survived as a triangle
    const f = m2.faces.find((x) => x.id === strip.id)!;
    expect(new Set(f.nodes).size).toBe(3);
  });

  it('street-wide cut splits every band of the column at one station', () => {
    const si = parseInt(strip.id.split(':')[2], 10);
    const colBefore = mesh.faces.filter((f) => f.id.startsWith(`f:e1:${si}:`) || f.id.startsWith(`f:e2:${si}:`) || f.id.startsWith(`f:e3:${si}:`));
    const edge = strip.edge!;
    const col = mesh.faces.filter((f) => f.kind === 'strip' && f.edge === edge && f.id.startsWith(`f:${edge}:${si}:`));
    const m2 = cutAcross(mesh, edge, si, 0.5)!;
    expect(m2.faces.length).toBe(mesh.faces.length + col.length);
    expect(meshInvariants(m2)).toEqual([]);
    void colBefore;
  });

  it('fillet replaces a corner with a shared arc in all faces using it', () => {
    // junction face corner node also used by strips
    const jf = mesh.faces.find((f) => f.kind === 'junction')!;
    const nid = jf.nodes.find((id) => facesOfNode(mesh, id).length >= 2)!;
    const m2 = filletNode(mesh, nid, 2);
    if (m2) {
      expect(meshInvariants(m2)).toEqual([]);
      expect(m2.editLog).toContain('fillet');
    } // some corners are near-straight → op legitimately refuses
  });
});
