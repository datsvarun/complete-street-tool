// Save / open / autosave. The document is exactly the undoable slice plus the
// projection origin and import hints — the "decisions" of Plan v2 §1.2. All
// geometry outside it is derived, so a document round-trip is lossless by
// construction. Version the schema from day one; loaders default missing
// fields and reject only structural nonsense.
import type { Boundary, GraphState, JunctionDesign, Patch, StreetElement } from './types';
import type { BusStopPoint, LatLon } from './osm/overpass';
import type { VertexOverrides } from './cad/vertexOverrides';
import type { MeshEdits } from './mesh/mesh';

export const DOC_VERSION = 1;

export interface CstDocument extends GraphState {
  version: number;
  app: 'cst';
  origin: LatLon | null;
  junctionDesigns: Record<string, JunctionDesign>;
  elements: Record<string, StreetElement>;
  nextElementNum: number;
  patches: Record<string, Patch>;
  nextPatchNum: number;
  boundaries: Record<string, Boundary>;
  nextBoundaryNum: number;
  vertexOverrides: VertexOverrides;
  meshEdits: MeshEdits;
  busStops: BusStopPoint[];
}

/** The store fields a document captures (what `toDocument` reads and
 *  `fromDocument` returns). */
export type DocumentSlice = Omit<CstDocument, 'version' | 'app'>;

export function toDocument(s: DocumentSlice): CstDocument {
  return {
    version: DOC_VERSION,
    app: 'cst',
    origin: s.origin,
    nodes: s.nodes,
    edges: s.edges,
    nextNodeNum: s.nextNodeNum,
    nextEdgeNum: s.nextEdgeNum,
    junctionDesigns: s.junctionDesigns,
    elements: s.elements,
    nextElementNum: s.nextElementNum,
    patches: s.patches,
    nextPatchNum: s.nextPatchNum,
    boundaries: s.boundaries,
    nextBoundaryNum: s.nextBoundaryNum,
    vertexOverrides: s.vertexOverrides,
    meshEdits: s.meshEdits,
    busStops: s.busStops,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural validation + defaults. Returns the loadable slice, or an error
 * string describing why the document can't be trusted.
 */
export function fromDocument(raw: unknown): DocumentSlice | string {
  if (!isRecord(raw)) return 'not a CST document (expected a JSON object)';
  if (raw.app !== 'cst' || typeof raw.version !== 'number') {
    return 'not a CST document (missing app/version marker)';
  }
  if (raw.version > DOC_VERSION) {
    return `document version ${raw.version} is newer than this app (v${DOC_VERSION})`;
  }
  if (!isRecord(raw.nodes) || !isRecord(raw.edges)) return 'document has no graph';
  const nodes = raw.nodes as GraphState['nodes'];
  const edges = raw.edges as GraphState['edges'];
  for (const n of Object.values(nodes)) {
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') return 'corrupt node record';
  }
  for (const e of Object.values(edges)) {
    if (!e || !Array.isArray(e.points) || e.points.length < 4) return 'corrupt edge record';
    if (!nodes[e.a] || !nodes[e.b]) return `edge ${e.id} references a missing node`;
  }
  const origin = isRecord(raw.origin) &&
    typeof raw.origin.lat === 'number' && typeof raw.origin.lon === 'number'
    ? { lat: raw.origin.lat, lon: raw.origin.lon }
    : null;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const maxNum = (ids: string[], prefix: string) =>
    ids.reduce((m, id) => Math.max(m, parseInt(id.slice(prefix.length), 10) || 0), 0) + 1;
  return {
    origin,
    nodes,
    edges,
    nextNodeNum: num(raw.nextNodeNum, maxNum(Object.keys(nodes), 'n')),
    nextEdgeNum: num(raw.nextEdgeNum, maxNum(Object.keys(edges), 'e')),
    junctionDesigns: isRecord(raw.junctionDesigns)
      ? (raw.junctionDesigns as Record<string, JunctionDesign>)
      : {},
    elements: isRecord(raw.elements) ? (raw.elements as Record<string, StreetElement>) : {},
    nextElementNum: num(raw.nextElementNum, maxNum(Object.keys(isRecord(raw.elements) ? raw.elements : {}), 'x')),
    patches: isRecord(raw.patches) ? (raw.patches as Record<string, Patch>) : {},
    nextPatchNum: num(raw.nextPatchNum, maxNum(Object.keys(isRecord(raw.patches) ? raw.patches : {}), 'p')),
    boundaries: isRecord(raw.boundaries) ? (raw.boundaries as Record<string, Boundary>) : {},
    nextBoundaryNum: num(raw.nextBoundaryNum, maxNum(Object.keys(isRecord(raw.boundaries) ? raw.boundaries : {}), 'b')),
    vertexOverrides: isRecord(raw.vertexOverrides) ? (raw.vertexOverrides as VertexOverrides) : {},
    meshEdits: isRecord(raw.meshEdits) ? (raw.meshEdits as MeshEdits) : {},
    busStops: Array.isArray(raw.busStops) ? (raw.busStops as BusStopPoint[]) : [],
  };
}

export const AUTOSAVE_KEY = 'cst.autosave.v1';

export function readAutosave(): DocumentSlice | null {
  try {
    const rawStr = localStorage.getItem(AUTOSAVE_KEY);
    if (!rawStr) return null;
    const slice = fromDocument(JSON.parse(rawStr));
    return typeof slice === 'string' ? null : slice;
  } catch {
    return null;
  }
}

export function writeAutosave(s: DocumentSlice): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toDocument(s)));
  } catch {
    // storage full/unavailable — autosave is best-effort
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // ignore
  }
}

/** Trigger a browser download of the document as pretty-printed JSON. */
export function downloadDocument(s: DocumentSlice, filename = 'street-design.cst.json'): void {
  const blob = new Blob([JSON.stringify(toDocument(s), null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
