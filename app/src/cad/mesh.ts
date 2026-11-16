// Welded node-mesh over the generated geometry (Mesh_Architecture.md).
//
// Every generated polygon (ribbon band, junction ring, wedge/nose, node
// transition) is derived independently, but abutting shapes share coordinates
// by construction — a carriageway band's edge and its footpath neighbour both
// sample the same offset polyline. Welding coincident vertices into shared
// MESH NODES makes that adjacency editable: dragging one node moves every
// member vertex, so abutting sub-polygons (one function each) change shape
// together and never tear apart.
//
// Derived, not stored: the mesh is rebuilt from the current geometry; a drag
// writes one parametric (along, across) delta PER MEMBER SHAPE through the
// existing vertexOverrides engine. Each member re-applies its own delta on
// regeneration and independently lands on the same world point, so welds
// survive node moves, width edits and re-derivation.
import type { GraphState } from '../types';
import { buildEdgeGeometry } from '../sections/transition';
import type { NodeArtifacts } from '../graph/junctions';
import { applyShapeOverrides, deltaForDrag } from './vertexOverrides';
import type { VertexOverrides } from './vertexOverrides';

/** One shape participating in a weld: its key, base outline, vertex index. */
export interface MeshMember {
  shapeKey: string;
  basePolygon: number[];
  vertexIndex: number;
}

/** Weld tolerance: generated coincident vertices agree to float precision;
 *  2 cm absorbs rounding without gluing genuinely distinct points. */
const WELD_TOL = 0.02;

const cellOf = (x: number, y: number) => `${Math.round(x / WELD_TOL / 4)}:${Math.round(y / WELD_TOL / 4)}`;

/** All generated shapes that could abut `targetKey`, with base polygons. */
function candidateShapes(
  g: GraphState,
  artifacts: NodeArtifacts,
  targetKey: string,
): Array<{ key: string; polygon: number[] }> {
  const out: Array<{ key: string; polygon: number[] }> = [];
  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const { bands } = buildEdgeGeometry(e, artifacts.trims[e.id]);
    for (const b of bands) out.push({ key: `band:${e.id}:${b.key}`, polygon: b.polygon });
  }
  for (const j of artifacts.junctions) {
    out.push({ key: `jring:${j.key}`, polygon: j.polygon });
    for (const b of [...j.wedges, ...j.noses]) {
      out.push({ key: `jband:${j.key}:${b.key}`, polygon: b.polygon });
    }
  }
  for (const t of artifacts.transitions) {
    for (const b of t.bands) out.push({ key: `t:${t.nodeId}:${b.key}`, polygon: b.polygon });
  }
  // the target must be present even if it fell through the filters above
  if (!out.some((s) => s.key === targetKey)) return out;
  return out;
}

/**
 * Weld map for one shape: for each vertex of `targetKey`'s base outline, the
 * member vertices of OTHER shapes welded to it (coincident within WELD_TOL on
 * the base geometry). Members do not include the target vertex itself.
 */
export function weldMapFor(
  g: GraphState,
  artifacts: NodeArtifacts,
  targetKey: string,
): MeshMember[][] {
  const shapes = candidateShapes(g, artifacts, targetKey);
  const target = shapes.find((s) => s.key === targetKey);
  if (!target) return [];

  // spatial hash of every vertex of every other shape
  const hash = new Map<string, MeshMember[]>();
  for (const s of shapes) {
    if (s.key === targetKey) continue;
    for (let i = 0; i * 2 < s.polygon.length; i++) {
      const k = cellOf(s.polygon[i * 2], s.polygon[i * 2 + 1]);
      (hash.get(k) ?? hash.set(k, []).get(k)!).push({
        shapeKey: s.key,
        basePolygon: s.polygon,
        vertexIndex: i,
      });
    }
  }

  const n = target.polygon.length / 2;
  const out: MeshMember[][] = [];
  for (let i = 0; i < n; i++) {
    const x = target.polygon[i * 2];
    const y = target.polygon[i * 2 + 1];
    const members: MeshMember[] = [];
    // check the 3×3 cell neighbourhood (tolerance can straddle a cell edge)
    const cx = Math.round(x / WELD_TOL / 4);
    const cy = Math.round(y / WELD_TOL / 4);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const m of hash.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const mx = m.basePolygon[m.vertexIndex * 2];
          const my = m.basePolygon[m.vertexIndex * 2 + 1];
          if (Math.abs(mx - x) < WELD_TOL && Math.abs(my - y) < WELD_TOL) members.push(m);
        }
      }
    }
    out.push(members);
  }
  return out;
}

/**
 * Drag of target vertex `i` to world (wx, wy) → the batch of per-shape deltas
 * that lands EVERY welded member on that same world point.
 */
export function weldedDragDeltas(
  targetKey: string,
  targetBase: number[],
  weldMap: MeshMember[][],
  overrides: VertexOverrides,
  i: number,
  wx: number,
  wy: number,
): Array<{ shapeKey: string; key: string; delta: { a: number; c: number } }> {
  const out = [
    { shapeKey: targetKey, ...deltaForDrag(targetBase, overrides[targetKey], i, wx, wy) },
  ];
  for (const m of weldMap[i] ?? []) {
    out.push({
      shapeKey: m.shapeKey,
      ...deltaForDrag(m.basePolygon, overrides[m.shapeKey], m.vertexIndex, wx, wy),
    });
  }
  return out;
}

/** Current (override-applied) outline for any shape key — display parity. */
export function displayedPolygon(base: number[], overrides: VertexOverrides, shapeKey: string): number[] {
  return applyShapeOverrides(base, overrides[shapeKey]);
}
