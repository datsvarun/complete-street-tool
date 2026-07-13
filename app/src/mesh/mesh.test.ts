import { describe, expect, it } from 'vitest';
import type { EdgeSection, GraphState, SectionComponent } from '../types';
import { buildMesh, applyMeshEdits, facePolygon, resolveNodeKey, WELD_TOL_M } from './mesh';
import { collectMeshSources, deriveMeshView } from './meshGeometry';

const comp = (element: string, kind: SectionComponent['kind'], widthM: number): SectionComponent =>
  ({ element, kind, widthM });

const section = (): EdgeSection => ({
  catalogId: null,
  components: [
    comp('Footpath', 'footpath', 2.5),
    comp('Cycle Track', 'cycle', 2),
    comp('Carriageway', 'carriageway', 7),
    comp('Cycle Track', 'cycle', 2),
    comp('Footpath', 'footpath', 2.5),
  ],
});

/** 4-way junction at n0 with 60 m straight approaches, uniform section. */
function crossGraph(): GraphState {
  const nodes = {
    n0: { id: 'n0', x: 0, y: 0 },
    n1: { id: 'n1', x: -60, y: 0 },
    n2: { id: 'n2', x: 60, y: 0 },
    n3: { id: 'n3', x: 0, y: -60 },
    n4: { id: 'n4', x: 0, y: 60 },
  };
  const edge = (id: string, a: string, b: string): GraphState['edges'][string] => ({
    id,
    a,
    b,
    points: [nodes[a as 'n0'].x, nodes[a as 'n0'].y, nodes[b as 'n0'].x, nodes[b as 'n0'].y],
    section: section(),
  });
  return {
    nodes,
    edges: {
      e1: edge('e1', 'n1', 'n0'),
      e2: edge('e2', 'n0', 'n2'),
      e3: edge('e3', 'n3', 'n0'),
      e4: edge('e4', 'n0', 'n4'),
    },
    nextNodeNum: 5,
    nextEdgeNum: 5,
  };
}

const distinctShapes = (mesh: ReturnType<typeof buildMesh>, nodeId: number): Set<string> =>
  new Set(mesh.nodeFaces[nodeId].map((fi) => mesh.faces[fi].shapeKey));

describe('buildMesh on real derived geometry', () => {
  const g = crossGraph();
  const sources = collectMeshSources(g, undefined, true, {});
  const mesh = buildMesh(sources);

  it('welds: node count is well below total source vertex count', () => {
    const totalVerts = sources.reduce((s, src) => s + src.polygon.length / 2, 0);
    expect(mesh.xs.length).toBeLessThan(totalVerts * 0.8);
    expect(mesh.sharedNodeCount).toBeGreaterThan(0);
  });

  it('round-trips every source polygon within the weld tolerance', () => {
    for (const src of sources) {
      const fi = mesh.faceIndexByShape.get(src.shapeKey)!;
      const poly = facePolygon(mesh.faces[fi], mesh.xs, mesh.ys);
      expect(poly.length).toBe(src.polygon.length);
      for (let i = 0; i < poly.length; i += 2) {
        const d = Math.hypot(poly[i] - src.polygon[i], poly[i + 1] - src.polygon[i + 1]);
        expect(d).toBeLessThanOrEqual(WELD_TOL_M + 1e-9);
      }
    }
  });

  it('adjacent bands of one edge share their boundary nodes', () => {
    // the carriageway band and a cycle band of e1 must reference common nodes
    const car = mesh.faces[mesh.faceIndexByShape.get('band:e1:s0-2-Carriageway')!];
    const cyc = mesh.faces[mesh.faceIndexByShape.get('band:e1:s0-1-Cycle Track')!];
    const shared = car.nodeIds.filter((id) => cyc.nodeIds.includes(id));
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });

  it('ribbon mouths weld onto the junction ring and corner wedges', () => {
    // at least some nodes are shared between a band: face and a jring:/jband: face
    let bandToJunction = 0;
    for (let id = 0; id < mesh.xs.length; id++) {
      const shapes = distinctShapes(mesh, id);
      const hasBand = [...shapes].some((s) => s.startsWith('band:'));
      const hasJ = [...shapes].some((s) => s.startsWith('jring:') || s.startsWith('jband:'));
      if (hasBand && hasJ) bandToJunction++;
    }
    expect(bandToJunction).toBeGreaterThanOrEqual(4); // one seam per approach at minimum
  });

  it('node keys are deterministic across rebuilds', () => {
    const again = buildMesh(collectMeshSources(g, undefined, true, {}));
    expect(again.nodeKeys).toEqual(mesh.nodeKeys);
  });
});

describe('mesh edits', () => {
  const g = crossGraph();
  const mesh = buildMesh(collectMeshSources(g, undefined, true, {}));

  const sharedNodeId = mesh.nodeFaces.findIndex(
    (fs, id) => distinctShapes(mesh, id).size >= 2 && fs.length >= 2,
  );
  const sharedKey = mesh.nodeKeys[sharedNodeId];

  it('displacing one shared node reshapes every member face and nothing else', () => {
    const { xs, ys, applied, stale, editedNodes } = applyMeshEdits(mesh, {
      [sharedKey]: { dx: 1.5, dy: -0.75 },
    });
    expect(applied).toBe(1);
    expect(stale).toBe(0);
    expect(editedNodes.has(sharedNodeId)).toBe(true);
    const memberFaces = new Set(mesh.nodeFaces[sharedNodeId]);
    expect(memberFaces.size).toBeGreaterThanOrEqual(2);
    mesh.faces.forEach((f, fi) => {
      const before = facePolygon(f, mesh.xs, mesh.ys);
      const after = facePolygon(f, xs, ys);
      const changed = before.some((v, i) => v !== after[i]);
      expect(changed).toBe(memberFaces.has(fi));
    });
  });

  it('skips stale keys without applying anything', () => {
    const { applied, stale } = applyMeshEdits(mesh, {
      'band:e9:s0-0-Ghost@0.5000': { dx: 1, dy: 1 },
    });
    expect(applied).toBe(0);
    expect(stale).toBe(1);
  });

  it('survives regeneration via nearest-fraction matching when geometry shifts', () => {
    // widen the carriageway slightly: every band coordinate moves, exact keys
    // may miss, but fraction matching inside the same shape must recover
    const g2 = crossGraph();
    for (const e of Object.values(g2.edges)) e.section!.components[2].widthM = 7.2;
    const mesh2 = buildMesh(collectMeshSources(g2, undefined, true, {}));
    const id2 = resolveNodeKey(mesh2, sharedKey);
    expect(id2).toBeGreaterThanOrEqual(0);
    const { applied } = applyMeshEdits(mesh2, { [sharedKey]: { dx: 1, dy: 0 } });
    expect(applied).toBe(1);
  });
});

describe('deriveMeshView', () => {
  it('memoizes by identity and preserves untouched polygon identity across edits', () => {
    const g = crossGraph();
    const vo = {}; // identity-stable, like the store slice
    const edits0 = {};
    const v0 = deriveMeshView(g, undefined, true, vo, edits0);
    expect(deriveMeshView(g, undefined, true, vo, edits0)).toBe(v0);

    const anyBandKey = v0.mesh.faces.find((f) => f.shapeKey.startsWith('band:'))!.shapeKey;
    const untouched = v0.polygon(anyBandKey)!;

    // edit a node on a DIFFERENT edge's band
    const otherFace = v0.mesh.faces.find(
      (f) => f.shapeKey.startsWith('band:') && !f.shapeKey.startsWith(anyBandKey.slice(0, 8)),
    )!;
    const nodeKey = v0.mesh.nodeKeys[otherFace.nodeIds[0]];
    const v1 = deriveMeshView(g, undefined, true, vo, { [nodeKey]: { dx: 0.5, dy: 0.5 } });
    expect(v1).not.toBe(v0);
    expect(v1.applied).toBe(1);
    // faces not adjacent to the edited node keep their exact array identity
    if (!v1.mesh.nodeFaces[otherFace.nodeIds[0]].includes(v1.mesh.faceIndexByShape.get(anyBandKey)!)) {
      expect(v1.polygon(anyBandKey)).toBe(untouched);
    }
  });
});
