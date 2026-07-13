// Derived mesh view over the whole design — the single place every consumer
// (canvas, 3D, exports) gets FINAL polygons from once mesh edits exist.
//
// Two-level identity memo, same discipline as deriveNodeArtifactsCached:
//  1. base mesh — rebuilt when the graph / junction designs / blend /
//     vertexOverrides change;
//  2. view — re-applies MeshEdits onto the cached base mesh; polygons of
//     faces untouched by the edit diff keep their array identity so memoized
//     Konva shapes skip reconciliation during drags.
import type { GraphState, JunctionDesign } from '../types';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import { buildEdgeGeometry } from '../sections/transition';
import { applyShapeOverrides } from '../cad/vertexOverrides';
import type { VertexOverrides } from '../cad/vertexOverrides';
import type { Mesh, MeshEdits, MeshSourceShape } from './mesh';
import { applyMeshEdits, buildMesh, facePolygon, resolveNodeKey } from './mesh';

export interface MeshView {
  mesh: Mesh;
  /** Displaced node coordinates (base + applied edits). */
  xs: number[];
  ys: number[];
  applied: number;
  stale: number;
  editedNodes: Set<number>;
  /** Final polygon for a generated shape, or null when the shape is not part
   *  of the mesh (no section, culled, legacy key). Stable array identity for
   *  faces whose nodes did not move since the previous view. */
  polygon(shapeKey: string): number[] | null;
}

/** Every generated surface polygon, keyed exactly like vertexOverrides /
 *  the renderers key them, with vertexOverrides pre-applied so the mesh is
 *  built on the same base geometry every consumer displays. */
export function collectMeshSources(
  g: GraphState,
  designs: Record<string, JunctionDesign> | undefined,
  blend: boolean,
  vertexOverrides: VertexOverrides,
): MeshSourceShape[] {
  const { junctions, transitions, trims } = deriveNodeArtifactsCached(g, designs, blend);
  const out: MeshSourceShape[] = [];
  const withOv = (key: string, polygon: number[]) =>
    applyShapeOverrides(polygon, vertexOverrides[key]);

  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const { bands } = buildEdgeGeometry(e, trims[e.id]);
    for (const b of bands) {
      const key = `band:${e.id}:${b.key}`;
      out.push({ shapeKey: key, element: b.element, kind: b.kind, polygon: withOv(key, b.polygon) });
    }
  }
  for (const j of junctions) {
    const ringKey = `jring:${j.key}`;
    out.push({ shapeKey: ringKey, element: 'Junction', kind: 'junction', polygon: withOv(ringKey, j.polygon) });
    j.coverBands.forEach((b, bi) => {
      out.push({ shapeKey: `jcover:${j.key}:${bi}`, element: 'Junction', kind: 'junction', polygon: b });
    });
    for (const b of [...j.wedges, ...j.noses]) {
      const key = `jband:${j.key}:${b.key}`;
      out.push({ shapeKey: key, element: b.element, kind: b.kind, polygon: withOv(key, b.polygon) });
    }
  }
  for (const t of transitions) {
    for (const b of t.bands) {
      out.push({ shapeKey: `tband:${t.nodeId}:${b.key}`, element: b.element, kind: b.kind, polygon: b.polygon });
    }
  }
  return out;
}

interface BaseCache {
  nodes: GraphState['nodes'];
  edges: GraphState['edges'];
  designs: Record<string, JunctionDesign> | undefined;
  blend: boolean;
  vertexOverrides: VertexOverrides;
  mesh: Mesh;
}
let baseCache: BaseCache | null = null;

interface ViewCache {
  mesh: Mesh;
  edits: MeshEdits;
  view: MeshView;
  polygons: Map<string, number[]>;
}
let viewCache: ViewCache | null = null;

function baseMeshCached(
  g: GraphState,
  designs: Record<string, JunctionDesign> | undefined,
  blend: boolean,
  vertexOverrides: VertexOverrides,
): Mesh {
  if (
    baseCache &&
    baseCache.nodes === g.nodes &&
    baseCache.edges === g.edges &&
    baseCache.designs === designs &&
    baseCache.blend === blend &&
    baseCache.vertexOverrides === vertexOverrides
  ) {
    return baseCache.mesh;
  }
  const mesh = buildMesh(collectMeshSources(g, designs, blend, vertexOverrides));
  baseCache = { nodes: g.nodes, edges: g.edges, designs, blend, vertexOverrides, mesh };
  return mesh;
}

/** Node keys whose values differ between two edit records. */
function editDiff(a: MeshEdits, b: MeshEdits): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a)) {
    const va = a[k];
    const vb = b[k];
    if (!vb || va.dx !== vb.dx || va.dy !== vb.dy) out.push(k);
  }
  for (const k of Object.keys(b)) if (!(k in a)) out.push(k);
  return out;
}

export function deriveMeshView(
  g: GraphState,
  designs: Record<string, JunctionDesign> | undefined,
  blend: boolean,
  vertexOverrides: VertexOverrides,
  meshEdits: MeshEdits,
): MeshView {
  const mesh = baseMeshCached(g, designs, blend, vertexOverrides);
  if (viewCache && viewCache.mesh === mesh && viewCache.edits === meshEdits) {
    return viewCache.view;
  }

  const { xs, ys, applied, stale, editedNodes } = applyMeshEdits(mesh, meshEdits);

  // Carry forward polygons of faces whose nodes did not move — during a drag
  // only the faces around the dragged node re-materialise.
  const polygons = new Map<string, number[]>();
  if (viewCache && viewCache.mesh === mesh) {
    const dirtyFaces = new Set<number>();
    for (const key of editDiff(viewCache.edits, meshEdits)) {
      // resolveNodeKey, not keyToNode: a fraction-matched (regeneration-
      // survived) edit must still invalidate the faces it displaces.
      const id = resolveNodeKey(mesh, key);
      if (id < 0) continue; // stale keys never produced polygons
      for (const fi of mesh.nodeFaces[id]) dirtyFaces.add(fi);
    }
    for (const [shapeKey, poly] of viewCache.polygons) {
      const fi = mesh.faceIndexByShape.get(shapeKey);
      if (fi !== undefined && !dirtyFaces.has(fi)) polygons.set(shapeKey, poly);
    }
  }

  const view: MeshView = {
    mesh,
    xs,
    ys,
    applied,
    stale,
    editedNodes,
    polygon(shapeKey: string): number[] | null {
      const cached = polygons.get(shapeKey);
      if (cached) return cached;
      const fi = mesh.faceIndexByShape.get(shapeKey);
      if (fi === undefined) return null;
      const poly = facePolygon(mesh.faces[fi], xs, ys);
      polygons.set(shapeKey, poly);
      return poly;
    },
  };
  viewCache = { mesh, edits: meshEdits, view, polygons };
  return view;
}

export const hasMeshEdits = (edits: MeshEdits): boolean => Object.keys(edits).length > 0;
