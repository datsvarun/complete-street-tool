// 3D scaffold: the SAME derived design → a renderer-agnostic scene spec.
// Pure data out (prisms + posts), no three.js here — the viewer consumes it,
// tests assert on it, and a future exporter (glTF/IFC) can reuse it. Heights
// follow Indian practice: carriageway at road level, 150 mm kerb for raised
// components, cycle tracks halfway.
import type { GraphState, JunctionDesign, Patch, StreetElement, ComponentKind } from '../types';
import { KIND_COLORS } from '../catalog';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import { buildEdgeGeometry } from '../sections/transition';
import { elementFrame } from '../detailing/elements';
import { applyShapeOverrides } from '../cad/vertexOverrides';
import { deriveMeshView, hasMeshEdits } from '../mesh/meshGeometry';
import type { MeshEdits } from '../mesh/mesh';
import type { VertexOverrides } from '../cad/vertexOverrides';
import { graphBounds } from '../graph/ops';
import type { Bounds } from '../store';

/** Extruded footprint: `polygon` (flat world metres) raised `height` from `base`. */
export interface ScenePrism {
  key: string;
  polygon: number[];
  base: number;   // metres above ground
  height: number;
  color: string;
}

/** Vertical element at a point (tree, light pole, small furniture). */
export interface ScenePost {
  key: string;
  kind: 'tree' | 'streetlight' | 'furniture';
  x: number;
  y: number;
}

export interface SceneSpec {
  prisms: ScenePrism[];
  posts: ScenePost[];
  bounds: Bounds | null;
}

const ROAD_H = 0.06;   // asphalt slab above formation
const KERB_H = 0.21;   // raised components: road + 150 mm kerb
const CYCLE_H = 0.16;  // cycle tracks sit between road and footpath

const KIND_HEIGHT: Record<ComponentKind, number> = {
  carriageway: ROAD_H,
  mixed: ROAD_H,
  service: ROAD_H,
  brt: ROAD_H,
  parking: ROAD_H,
  busstop: KERB_H,
  cycle: CYCLE_H,
  footpath: KERB_H,
  muz: KERB_H,
  mfz: KERB_H,
  buffer: KERB_H,
  tree: KERB_H,
  livability: KERB_H,
  median: KERB_H,
  metro: KERB_H,
  other: KERB_H,
};

export function buildScene(
  g: GraphState,
  designs: Record<string, JunctionDesign>,
  elements: StreetElement[],
  patches: Patch[] = [],
  vertexOverrides: VertexOverrides = {},
  blend = true,
  meshEdits: MeshEdits = {},
): SceneSpec {
  const { junctions, transitions, trims } = deriveNodeArtifactsCached(g, designs, blend);
  // 3D prisms extrude the same final surfaces the plan shows: mesh-edited
  // welded geometry when present (mesh polygons already carry vertexOverrides).
  const meshView = hasMeshEdits(meshEdits)
    ? deriveMeshView(g, designs, blend, vertexOverrides, meshEdits)
    : null;
  const finalPoly = (key: string, base: number[]) =>
    meshView?.polygon(key) ?? applyShapeOverrides(base, vertexOverrides[key]);
  const prisms: ScenePrism[] = [];
  const posts: ScenePost[] = [];

  // Edge ribbons — one prism per band, kerb heights by kind.
  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const { bands } = buildEdgeGeometry(e, trims[e.id]);
    for (const b of bands) {
      prisms.push({
        key: `band:${e.id}:${b.key}`,
        polygon: finalPoly(`band:${e.id}:${b.key}`, b.polygon),
        base: 0,
        height: KIND_HEIGHT[b.kind],
        color: KIND_COLORS[b.kind],
      });
    }
  }

  // Junction surfaces at road level; wedges/noses/transitions by kind.
  for (const j of junctions) {
    prisms.push({
      key: `jring:${j.key}`,
      polygon: finalPoly(`jring:${j.key}`, j.polygon),
      base: 0,
      height: ROAD_H,
      color: '#525e6a',
    });
    j.coverBands.forEach((b, i) =>
      prisms.push({
        key: `jcover:${j.key}:${i}`,
        polygon: meshView?.polygon(`jcover:${j.key}:${i}`) ?? b,
        base: 0,
        height: ROAD_H,
        color: '#525e6a',
      }),
    );
    for (const b of [...j.wedges, ...j.noses]) {
      prisms.push({
        key: `jband:${j.key}:${b.key}`,
        polygon: finalPoly(`jband:${j.key}:${b.key}`, b.polygon),
        base: 0,
        height: KIND_HEIGHT[b.kind],
        color: KIND_COLORS[b.kind],
      });
    }
    if (j.roundabout) {
      const { cx, cy, islandR } = j.roundabout;
      const circle: number[] = [];
      for (let a = 0; a < 32; a++) {
        circle.push(cx + islandR * Math.cos((a / 32) * 2 * Math.PI), cy + islandR * Math.sin((a / 32) * 2 * Math.PI));
      }
      prisms.push({ key: `jisl:${j.key}`, polygon: circle, base: 0, height: KERB_H, color: KIND_COLORS.median });
    }
  }
  for (const t of transitions) {
    for (const b of t.bands) {
      prisms.push({
        key: `t:${t.nodeId}:${b.key}`,
        polygon: meshView?.polygon(`tband:${t.nodeId}:${b.key}`) ?? b.polygon,
        base: 0,
        height: KIND_HEIGHT[b.kind],
        color: KIND_COLORS[b.kind],
      });
    }
  }

  // Edit-stage patches ('cut' has no 3D meaning yet — skipped).
  for (const p of patches) {
    if (p.kind === 'cut') continue;
    prisms.push({
      key: `patch:${p.id}`,
      polygon: p.points,
      base: 0,
      height: KIND_HEIGHT[p.kind],
      color: KIND_COLORS[p.kind],
    });
  }

  // Elements: verticals as posts; crossings as thin white slabs on the road.
  for (const el of elements) {
    const edge = g.edges[el.edgeId];
    if (!edge?.section) continue;
    if (el.kind === 'tree' || el.kind === 'streetlight') {
      const f = elementFrame(edge, el);
      posts.push({ key: el.id, kind: el.kind, x: f.x, y: f.y });
    } else if (el.kind === 'bench' || el.kind === 'dustbin' || el.kind === 'busstop') {
      const f = elementFrame(edge, el);
      posts.push({ key: el.id, kind: 'furniture', x: f.x, y: f.y });
    }
  }

  return { prisms, posts, bounds: graphBounds(g) };
}
