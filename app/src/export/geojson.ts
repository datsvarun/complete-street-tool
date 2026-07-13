// GeoJSON export: the whole derived design as a FeatureCollection in WGS84.
// Reuses the same derivations as the canvas/SVG plan; lat/lon only appears
// here at the boundary (CLAUDE.md rule). Consumers: QGIS, Kepler, geojson.io,
// any GIS pipeline. DXF export is designed in Export_Design.md (root).
import type { Boundary, GraphState, JunctionDesign, Patch, StreetElement } from '../types';
import type { LatLon } from '../osm/overpass';
import { toLatLon } from '../osm/overpass';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import type { CornerMode } from '../graph/junctions';
import { buildEdgeGeometry } from '../sections/transition';
import { elementFrame } from '../detailing/elements';
import { applyShapeOverrides } from '../cad/vertexOverrides';
import type { Mesh } from '../mesh/engine';
import type { VertexOverrides } from '../cad/vertexOverrides';

type Feature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

function lineCoords(origin: LatLon, flat: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = toLatLon(origin, flat[i], flat[i + 1]);
    out.push([r6(p.lon), r6(p.lat)]);
  }
  return out;
}

function polygonCoords(origin: LatLon, flat: number[]): number[][][] {
  const ring = lineCoords(origin, flat);
  if (ring.length > 0) ring.push(ring[0]); // close
  return [ring];
}

export function buildGeoJson(
  g: GraphState,
  origin: LatLon,
  designs: Record<string, JunctionDesign>,
  elements: StreetElement[],
  patches: Patch[],
  boundaries: Boundary[],
  vertexOverrides: VertexOverrides = {},
  corners: CornerMode = 'blend',
  mesh: Mesh | null = null,
): string {
  const { junctions, transitions, trims } = deriveNodeArtifactsCached(g, designs, corners);
  const features: Feature[] = [];

  // A frozen node-mesh replaces every generated surface polygon — one feature
  // per face, carrying its function and id.
  if (mesh) {
    for (const f of mesh.faces) {
      const pts: number[] = [];
      for (const nid of f.nodes) {
        const p = mesh.nodes[nid];
        if (p) pts.push(p.x, p.y);
      }
      if (pts.length < 6) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: polygonCoords(origin, pts) },
        properties: { layer: 'mesh-face', id: f.id, fn: f.fn, kind: f.kind, edgeId: f.edge ?? null },
      });
    }
  }

  for (const e of Object.values(g.edges)) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: lineCoords(origin, e.points) },
      properties: {
        layer: 'centerline',
        id: e.id,
        name: e.name ?? null,
        highway: e.highway ?? null,
        oneway: !!e.oneway,
        lanes: e.lanes ?? null,
        rowWidthM: e.section ? e.section.components.reduce((s, c) => s + c.widthM, 0) : null,
      },
    });
    if (!e.section || mesh) continue;
    const { bands } = buildEdgeGeometry(e, trims[e.id]);
    for (const b of bands) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: polygonCoords(origin, applyShapeOverrides(b.polygon, vertexOverrides[`band:${e.id}:${b.key}`])),
        },
        properties: { layer: 'band', edgeId: e.id, kind: b.kind, key: b.key },
      });
    }
  }

  for (const j of mesh ? [] : junctions) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: polygonCoords(origin, applyShapeOverrides(j.polygon, vertexOverrides[`jring:${j.key}`])),
      },
      properties: { layer: 'junction', key: j.key, degree: j.degree, names: j.names.join(' × ') },
    });
    for (const b of [...j.wedges, ...j.noses]) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: polygonCoords(origin, applyShapeOverrides(b.polygon, vertexOverrides[`jband:${j.key}:${b.key}`])),
        },
        properties: { layer: 'junction-band', key: j.key, kind: b.kind },
      });
    }
  }
  for (const t of transitions) {
    for (const b of t.bands) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: polygonCoords(origin, b.polygon) },
        properties: { layer: 'transition', nodeId: t.nodeId, kind: b.kind },
      });
    }
  }

  for (const el of elements) {
    const edge = g.edges[el.edgeId];
    if (!edge?.section) continue;
    const f = elementFrame(edge, el);
    const p = toLatLon(origin, f.x, f.y);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r6(p.lon), r6(p.lat)] },
      properties: {
        layer: 'element',
        id: el.id,
        kind: el.kind,
        variant: el.variant ?? null,
        edgeId: el.edgeId,
        stationM: Math.round(el.stationM * 100) / 100,
        ...el.props,
      },
    });
  }

  for (const p of patches) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: polygonCoords(origin, p.points) },
      properties: { layer: 'patch', id: p.id, kind: p.kind },
    });
  }
  for (const b of boundaries) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: lineCoords(origin, b.points) },
      properties: { layer: 'boundary', id: b.id },
    });
  }

  return JSON.stringify(
    {
      type: 'FeatureCollection',
      properties: { generator: 'CST · IRC Street Designer', crs: 'EPSG:4326', origin },
      features,
    },
    null,
    1,
  );
}
