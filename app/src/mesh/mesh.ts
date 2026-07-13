// Shared-node mesh (Mesh_Integration_Spec §2/§4, assets/MESH_INTEGRATION_SPEC.md):
// the final-geometry stage after derivation. Every generated polygon (edge
// bands, junction rings, wedges, noses, covers, node transitions) becomes a
// face whose vertices are ids into ONE node table. Vertices that coincide
// (adjacent bands share an offset polyline exactly; ribbon mouths meet
// junction rings and wedges at the same trim stations) weld into a single
// node, so abutting geometry is connected by construction: displacing one
// node reshapes every face that references it, with no constraint solver.
//
// The mesh itself is derived — rebuilt from the graph on every change, never
// stored (Plan v2 §1.2). What persists is `MeshEdits`: world-space
// displacements keyed by a stable node key (`${shapeKey}@${perimeterFrac}` of
// the node's first member shape). Keys survive regeneration the same way
// vertexOverrides fraction keys do: exact match first, nearest-fraction match
// within tolerance second, silently skipped when stale (stale, not wrong).
import { vertexFractions, fracKey } from '../cad/vertexOverrides';

/** One generated polygon entering the mesh. `polygon` is the final derived
 *  outline (vertexOverrides already applied), flat [x0,y0,...] metres. */
export interface MeshSourceShape {
  shapeKey: string; // 'band:e1:s0-2-…' | 'jring:n3' | 'jband:…' | 'jcover:…' | 'tband:…'
  element: string;
  kind: string;     // ComponentKind or 'junction'
  polygon: number[];
}

export interface MeshFace {
  shapeKey: string;
  element: string;
  kind: string;
  nodeIds: number[]; // one per source vertex, same order as the source polygon
}

export interface Mesh {
  /** Base (unedited) node coordinates; node id = index. */
  xs: number[];
  ys: number[];
  /** Stable persistent key per node (first member shape @ perimeter fraction). */
  nodeKeys: string[];
  keyToNode: Map<string, number>;
  faces: MeshFace[];
  faceIndexByShape: Map<string, number>;
  /** node id → indices of faces referencing it (built once, used for
   *  adjacency highlighting and edit invalidation). */
  nodeFaces: number[][];
  /** Count of nodes referenced by 2+ distinct shapes — the welded seams. */
  sharedNodeCount: number;
}

/** World-space displacement per node key — the persisted, undoable edit slice. */
export type MeshEdits = Record<string, { dx: number; dy: number }>;

/** Welding tolerance (metres). Seams are exact (shared offset polylines) or
 *  near-exact (mouth stations reconstructed by two code paths); real design
 *  vertices are never this close together. */
export const WELD_TOL_M = 0.02;

/** Fraction tolerance when re-matching a stale node key after regeneration —
 *  mirrors cad/vertexOverrides FRAC_TOL. */
const FRAC_TOL = 0.02;

/**
 * Weld source polygons into a shared-node mesh. Deterministic: sources are
 * processed in shapeKey order, so node ids and keys are reproducible for
 * identical inputs.
 */
export function buildMesh(sources: MeshSourceShape[], tol = WELD_TOL_M): Mesh {
  const sorted = [...sources].sort((a, b) => (a.shapeKey < b.shapeKey ? -1 : a.shapeKey > b.shapeKey ? 1 : 0));
  const xs: number[] = [];
  const ys: number[] = [];
  const nodeKeys: string[] = [];
  const keyToNode = new Map<string, number>();
  const faces: MeshFace[] = [];
  const faceIndexByShape = new Map<string, number>();
  // spatial hash for welding: cell size = tol, search the 3×3 neighbourhood
  const grid = new Map<string, number[]>();
  const inv = 1 / tol;
  const tol2 = tol * tol;

  const findOrCreate = (x: number, y: number, key: string): number => {
    const cx = Math.round(x * inv);
    const cy = Math.round(y * inv);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const id of bucket) {
          const dx = xs[id] - x;
          const dy = ys[id] - y;
          if (dx * dx + dy * dy <= tol2) return id;
        }
      }
    }
    const id = xs.length;
    xs.push(x);
    ys.push(y);
    // stable key: first member shape + perimeter fraction; disambiguate rare
    // same-fraction collisions deterministically
    let k = key;
    let n = 1;
    while (keyToNode.has(k)) k = `${key}~${n++}`;
    nodeKeys.push(k);
    keyToNode.set(k, id);
    const cellKey = `${cx}:${cy}`;
    const bucket = grid.get(cellKey);
    if (bucket) bucket.push(id);
    else grid.set(cellKey, [id]);
    return id;
  };

  for (const src of sorted) {
    if (src.polygon.length < 6 || faceIndexByShape.has(src.shapeKey)) continue;
    const fracs = vertexFractions(src.polygon, true);
    const nodeIds: number[] = [];
    for (let i = 0; i * 2 < src.polygon.length; i++) {
      nodeIds.push(
        findOrCreate(
          src.polygon[i * 2],
          src.polygon[i * 2 + 1],
          `${src.shapeKey}@${fracKey(fracs[i])}`,
        ),
      );
    }
    faceIndexByShape.set(src.shapeKey, faces.length);
    faces.push({ shapeKey: src.shapeKey, element: src.element, kind: src.kind, nodeIds });
  }

  const nodeFaces: number[][] = Array.from({ length: xs.length }, () => []);
  faces.forEach((f, fi) => {
    for (const id of f.nodeIds) {
      const list = nodeFaces[id];
      if (list[list.length - 1] !== fi) list.push(fi);
    }
  });
  let sharedNodeCount = 0;
  for (const list of nodeFaces) if (list.length > 1) sharedNodeCount++;

  return { xs, ys, nodeKeys, keyToNode, faces, faceIndexByShape, nodeFaces, sharedNodeCount };
}

/** Split a node key into its shape key and fraction. The fraction is the part
 *  after the LAST `@` (shape keys never contain `@`), with any `~n`
 *  disambiguator stripped. */
function parseNodeKey(key: string): { shapeKey: string; frac: number } | null {
  const at = key.lastIndexOf('@');
  if (at < 0) return null;
  const frac = parseFloat(key.slice(at + 1));
  if (!Number.isFinite(frac)) return null;
  return { shapeKey: key.slice(0, at), frac };
}

export interface AppliedEdits {
  /** Displaced coordinates (copies — the base mesh stays untouched). */
  xs: number[];
  ys: number[];
  applied: number;
  stale: number;
  /** Node ids that received a displacement. */
  editedNodes: Set<number>;
}

/**
 * Resolve a node key against a (possibly regenerated) mesh: exact key first,
 * then same-shape nearest perimeter fraction within FRAC_TOL. Returns -1 when
 * the key is stale (shape gone, outline reshaped beyond recognition).
 */
export function resolveNodeKey(mesh: Mesh, key: string): number {
  const exact = mesh.keyToNode.get(key);
  if (exact !== undefined) return exact;
  const parsed = parseNodeKey(key);
  if (!parsed) return -1;
  const fi = mesh.faceIndexByShape.get(parsed.shapeKey);
  if (fi === undefined) return -1;
  const face = mesh.faces[fi];
  const poly: number[] = [];
  for (const id of face.nodeIds) poly.push(mesh.xs[id], mesh.ys[id]);
  const fracs = vertexFractions(poly, true);
  let best = -1;
  let bestD = FRAC_TOL;
  for (let i = 0; i < fracs.length; i++) {
    let d = Math.abs(fracs[i] - parsed.frac);
    d = Math.min(d, 1 - d); // wrap-around distance on the closed outline
    if (d < bestD) {
      bestD = d;
      best = face.nodeIds[i];
    }
  }
  return best;
}

/** Apply world-space edits onto copies of the mesh coordinates. */
export function applyMeshEdits(mesh: Mesh, edits: MeshEdits): AppliedEdits {
  const xs = mesh.xs.slice();
  const ys = mesh.ys.slice();
  const editedNodes = new Set<number>();
  let applied = 0;
  let stale = 0;
  for (const [key, d] of Object.entries(edits)) {
    const id = resolveNodeKey(mesh, key);
    if (id < 0) {
      stale++;
      continue;
    }
    xs[id] = mesh.xs[id] + d.dx;
    ys[id] = mesh.ys[id] + d.dy;
    editedNodes.add(id);
    applied++;
  }
  return { xs, ys, applied, stale, editedNodes };
}

/** Rebuild a face's flat polygon from (possibly displaced) coordinates. */
export function facePolygon(face: MeshFace, xs: number[], ys: number[]): number[] {
  const out: number[] = new Array(face.nodeIds.length * 2);
  face.nodeIds.forEach((id, i) => {
    out[i * 2] = xs[id];
    out[i * 2 + 1] = ys[id];
  });
  return out;
}
