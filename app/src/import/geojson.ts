// GeoJSON → polylines. Reads LineString / MultiLineString geometries (points
// and polygons are ignored — streets are centerlines). Coordinates are WGS84
// lon/lat per the GeoJSON spec; projection happens here, at the import
// boundary (CLAUDE.md rule).
import { toLocal } from '../osm/overpass';
import type { LatLon } from '../osm/overpass';
import type { ImportLine } from './lines';

type Coord = number[];
type Props = Record<string, unknown>;
interface RawLine {
  coords: Coord[];
  props: Props;
}
export interface GeoJsonLines {
  lines: RawLine[];
  center: LatLon; // centre of the bounding box
}

function collect(node: unknown, props: Props, out: RawLine[]) {
  if (!node || typeof node !== 'object') return;
  const o = node as {
    type?: string;
    features?: unknown[];
    geometry?: unknown;
    geometries?: unknown[];
    properties?: Props | null;
    coordinates?: unknown;
  };
  if (o.type === 'FeatureCollection') o.features?.forEach((f) => collect(f, props, out));
  else if (o.type === 'Feature') collect(o.geometry, o.properties ?? {}, out);
  else if (o.type === 'GeometryCollection') o.geometries?.forEach((g) => collect(g, props, out));
  else if (o.type === 'LineString') out.push({ coords: o.coordinates as Coord[], props });
  else if (o.type === 'MultiLineString') (o.coordinates as Coord[][]).forEach((c) => out.push({ coords: c, props }));
}

/** Line strings in lon/lat, or null when the file has none or is not WGS84. */
export function readGeoJsonLines(raw: unknown): GeoJsonLines | null {
  const lines: RawLine[] = [];
  collect(raw, {}, lines);
  if (lines.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const l of lines) {
    for (const c of l.coords) {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
      if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) return null;
      minLon = Math.min(minLon, c[0]);
      maxLon = Math.max(maxLon, c[0]);
      minLat = Math.min(minLat, c[1]);
      maxLat = Math.max(maxLat, c[1]);
    }
  }
  return { lines, center: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 } };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Project onto the local metric plane around `origin`. */
export function geoJsonToLines(parsed: GeoJsonLines, origin: LatLon): ImportLine[] {
  return parsed.lines.map((l) => ({
    points: l.coords.flatMap((c) => {
      const p = toLocal(origin, { lat: c[1], lon: c[0] });
      return [p.x, p.y];
    }),
    name: str(l.props.name),
    highway: str(l.props.highway),
  }));
}
