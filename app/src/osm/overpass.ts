// OSM import: Overpass query → node-edge graph in the local metric CRS
// (Plan v2 §2.1 / Case_Study §1.7). Lat/lon exists only at this boundary —
// the projection origin is the one link between local metres and the world.
import type { GraphState } from '../types';

// Pune, Ganeshkhind Rd / Shivajinagar — messy: dual carriageway, flyover, service alleys.
export const DEFAULT_IMPORT = { lat: 18.5289, lon: 73.8478, radiusM: 250 };

export interface LatLon {
  lat: number;
  lon: number;
}

const K = 111320; // metres per degree latitude (local equirectangular)

export function toLocal(origin: LatLon, p: LatLon): { x: number; y: number } {
  const kLon = K * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lon - origin.lon) * kLon, y: -(p.lat - origin.lat) * K };
}

export function toLatLon(origin: LatLon, x: number, y: number): LatLon {
  const kLon = K * Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat - y / K, lon: origin.lon + x / kLon };
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Street classes that participate in street design; separate footway/path/steps
// geometries and construction/proposed ways are noise at this stage.
const KEEP = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'service', 'living_street', 'pedestrian',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

// Separate pedestrian-only geometries, off by default (see ImportFilters).
const KEEP_PATHS = new Set(['footway', 'path', 'steps', 'track']);

/** What the user chose to download / keep from OSM. */
export interface ImportFilters {
  /** Keep elevated ways (bridge=* flyovers). Off = at-grade network only. */
  flyovers: boolean;
  /** Keep highway=service alleys and parking aisles. */
  serviceRoads: boolean;
  /** Also import separate footway/path/steps geometries. */
  paths: boolean;
}

export const DEFAULT_FILTERS: ImportFilters = { flyovers: true, serviceRoads: true, paths: false };

interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
export interface OsmJson { elements: Array<OsmNode | OsmWay> }

async function runOverpass(query: string): Promise<OsmJson> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  return (await res.json()) as OsmJson;
}

/** Exact-extent fetch: only the user-confirmed box downloads. Also brings
 *  bus-stop nodes in the box for detailing suggestions. */
export async function fetchOverpassBbox(south: number, west: number, north: number, east: number): Promise<OsmJson> {
  const b = `${south},${west},${north},${east}`;
  return runOverpass(
    `[out:json][timeout:30];(way["highway"](${b});>;node["highway"="bus_stop"](${b}););out body;`,
  );
}

/** Bus-stop nodes in the download, projected to local metres — a hint layer
 *  for Stage 3 "suggest bus stops", not part of the graph. */
export interface BusStopPoint { x: number; y: number; name?: string }

export function parseBusStops(data: OsmJson, center: LatLon): BusStopPoint[] {
  const out: BusStopPoint[] = [];
  for (const el of data.elements) {
    if (el.type === 'node' && el.tags?.highway === 'bus_stop') {
      const p = toLocal(center, el);
      out.push({ x: p.x, y: p.y, ...(el.tags.name ? { name: el.tags.name } : {}) });
    }
  }
  return out;
}

function keepWay(tags: Record<string, string>, f: ImportFilters): boolean {
  const hw = tags.highway;
  if (!hw) return false;
  if (!(KEEP.has(hw) || (f.paths && KEEP_PATHS.has(hw)))) return false;
  if (!f.serviceRoads && hw === 'service') return false;
  if (!f.flyovers && tags.bridge && tags.bridge !== 'no') return false;
  return true;
}

/**
 * OSM ways → GraphState: keep street classes (per `filters`), split ways at
 * shared nodes, project to a local metric CRS around `center` (y grows
 * south/down). The caller stores `center` as the graph's projection origin.
 */
export function parseOsm(data: OsmJson, center: LatLon, filters: ImportFilters = DEFAULT_FILTERS): GraphState {
  const osmNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of data.elements) {
    if (el.type === 'node') osmNodes.set(el.id, el);
    else if (el.type === 'way' && el.tags && keepWay(el.tags, filters)) ways.push(el);
  }
  const proj = (n: OsmNode) => toLocal(center, n);

  // Usage count decides where ways get split: shared nodes become graph nodes.
  const usage = new Map<number, number>();
  for (const w of ways) {
    w.nodes.forEach((nid, i) => {
      const isEnd = i === 0 || i === w.nodes.length - 1;
      usage.set(nid, (usage.get(nid) ?? 0) + (isEnd ? 2 : 1));
    });
  }

  const g: GraphState = { nodes: {}, edges: {}, nextNodeNum: 1, nextEdgeNum: 1 };
  const nodeIdFor = new Map<number, string>();
  const getNode = (osmId: number): string | null => {
    const existing = nodeIdFor.get(osmId);
    if (existing) return existing;
    const n = osmNodes.get(osmId);
    if (!n) return null;
    const id = `n${g.nextNodeNum}`;
    g.nextNodeNum += 1;
    const p = proj(n);
    g.nodes[id] = { id, x: p.x, y: p.y };
    nodeIdFor.set(osmId, id);
    return id;
  };

  for (const w of ways) {
    const tags = w.tags!;
    const onewayTag = tags.oneway ?? (tags.junction === 'roundabout' ? 'yes' : undefined);
    const oneway = onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true' || onewayTag === '-1';
    const seq = onewayTag === '-1' ? [...w.nodes].reverse() : w.nodes;

    let runStart = 0;
    for (let i = 1; i < seq.length; i++) {
      const shared = (usage.get(seq[i]) ?? 0) >= 2;
      if (!shared && i < seq.length - 1) continue;
      const slice = seq.slice(runStart, i + 1).filter((nid) => osmNodes.has(nid));
      if (slice.length >= 2) {
        const aId = getNode(slice[0]);
        const bId = getNode(slice[slice.length - 1]);
        if (aId && bId) {
          const points: number[] = [];
          for (const nid of slice) {
            const p = proj(osmNodes.get(nid)!);
            points.push(p.x, p.y);
          }
          const id = `e${g.nextEdgeNum}`;
          g.nextEdgeNum += 1;
          g.edges[id] = {
            id, a: aId, b: bId, points,
            section: null,
            highway: tags.highway,
            name: tags.name,
            oneway,
          };
        }
      }
      runStart = i;
    }
  }
  return g;
}
