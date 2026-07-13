import { create } from 'zustand';
import { temporal } from 'zundo';
import type {
  Boundary,
  DcCandidate,
  DraftVert,
  ElementKind,
  GraphState,
  JunctionDesign,
  JunctionType,
  Patch,
  PatchKind,
  ReviewItem,
  SectionComponent,
  SelectMode,
  Stage,
  StreetEdge,
  StreetElement,
  Tool,
} from './types';
import { DEFAULT_WIDTH, pruneElements, resolveDrop, suggestBusStops, suggestElements, suggestTurnArrows, suggestZebras } from './detailing/elements';
import { projectOnPolyline } from './geometry/polyline';
import { deriveNodeArtifactsCached } from './graph/junctions';
import {
  commitDraft,
  deleteEdge,
  deleteNode,
  EMPTY_GRAPH,
  graphBounds,
  joinThroughNode,
  mergeNodes,
  moveEdgeVertex,
  moveNode,
  removeEdgeVertex,
  simplifyEdges,
  splitEdge,
} from './graph/ops';
import { runStandardPipeline } from './graph/transforms';
import { detectDualCarriageways, manualDcCandidate, mergeDualCarriageway } from './graph/dualCarriageway';
import { DEFAULT_FILTERS, fetchOverpassBbox, parseBusStops, parseOsm, toLatLon, toLocal, DEFAULT_IMPORT } from './osm/overpass';
import type { BusStopPoint, ImportFilters, LatLon } from './osm/overpass';
import { getSection } from './catalog';
import { autoAssignSections, materialize } from './sections/rules';
import { clearAutosave, fromDocument, readAutosave, writeAutosave } from './persistence';
import type { VertexDelta, VertexOverrides } from './cad/vertexOverrides';
import type { MeshEdits } from './mesh/mesh';

// One shared store across all stages; stage is a UI mode, not a data boundary
// (Plan v2 §1.1). The graph core (nodes/edges) is the undoable slice.

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export type Basemap = 'none' | 'osm' | 'sat';

/** App preferences — device-level, never part of the design document. */
export interface AppSettings {
  theme: 'day' | 'night';
  /** Traffic handedness: drives turn-arrow suggestions (India = LHT). */
  drive: 'lht' | 'rht';
  /** Blend unmatched components around junction corners (wedges). Off =
   *  non-matching bands simply end at the junction (user default). */
  junctionBlend: boolean;
  /** Hide sub-pixel detail when zoomed out (perf LOD). */
  lod: boolean;
}

export type LayerKey = 'roads' | 'junctions' | 'furniture' | 'markings' | 'patches' | 'boundaries';

export const LAYER_LABELS: Record<LayerKey, string> = {
  roads: 'Road sections',
  junctions: 'Junctions',
  furniture: 'Street furniture',
  markings: 'Markings & decals',
  patches: 'Edit patches',
  boundaries: 'Plot boundaries',
};

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  roads: true,
  junctions: true,
  furniture: true,
  markings: true,
  patches: true,
  boundaries: true,
};

const DEFAULT_SETTINGS: AppSettings = { theme: 'day', drive: 'lht', junctionBlend: false, lod: true };
const SETTINGS_KEY = 'cst.settings.v1';

function readSettings(): AppSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

interface CstState extends GraphState {
  stage: Stage;
  tool: Tool;
  /** Projection origin: lat/lon of local (0,0). Set by import or geocoding. */
  origin: LatLon | null;
  basemap: Basemap;
  selectedEdgeId: string | null;      // primary selection (last clicked)
  selectedEdgeIds: string[];          // full multi-selection (shift-click)
  /** Junction parameter overrides, keyed by sorted-node-id junction key.
   *  Only junctions the user touched appear here (Plan v2 §1.2). */
  junctionDesigns: Record<string, JunctionDesign>;
  selectedJunctionKey: string | null; // focused junction in stage 2A
  /** Stage 3 elements, anchored (edge, station, component, fraction). */
  elements: Record<string, StreetElement>;
  nextElementNum: number;
  placeKind: ElementKind | null;      // active palette tool (UI state)
  placeVariant: string | null;        // e.g. turn arrow direction
  selectedElementId: string | null;
  /** Traced land-ownership / ROW boundary polylines (undoable) + draw state (not). */
  boundaries: Record<string, Boundary>;
  nextBoundaryNum: number;
  boundaryDraw: boolean;              // tracing mode armed
  boundaryDraft: number[];            // in-progress polyline
  selectedBoundaryId: string | null;
  /** CAD keyed-vertex overrides on generated geometry (undoable, persisted).
   *  shapeKey → fraction-key → (along, across) nudge (CAD_Architecture §1–4). */
  vertexOverrides: VertexOverrides;
  /** Shared-node mesh edits (undoable, persisted): world-space displacements
   *  keyed by stable mesh node key. One drag of a welded node reshapes every
   *  abutting generated shape at once (MESH_INTEGRATION_SPEC §2/§4). */
  meshEdits: MeshEdits;
  /** Generated shape whose vertices are being edited (Edit stage, transient). */
  selectedShapeKey: string | null;
  /** Stage 3.5 edit: free-form patches (undoable) + drawing state (not). */
  patches: Record<string, Patch>;
  nextPatchNum: number;
  patchKind: PatchKind | null;        // armed material for drawing
  patchDraft: number[];               // in-progress polygon
  selectedPatchId: string | null;
  /** Rectangle-drawing mode: import extent or export extent (world metres). */
  boxDraw: 'import' | 'export' | null;
  importBox: Bounds | null;
  exportBounds: Bounds | null;
  /** What to keep when downloading from OSM (flyovers, service roads, paths). */
  importFilters: ImportFilters;
  /** Bus-stop nodes from the last OSM download (local metres) — suggestion hints. */
  busStops: BusStopPoint[];
  designOpacity: number;              // 0.2–1, sections/junctions layer alpha
  draft: DraftVert[];
  dcCandidates: DcCandidate[] | null; // null = not scanned yet
  highlightEdges: string[];
  pendingFit: Bounds | null;
  statusMsg: string;
  importBusy: boolean;
  reviewList: ReviewItem[];
  settings: AppSettings;
  /** Layer visibility (UI state): hiding a layer never touches the data. */
  layers: Record<LayerKey, boolean>;

  setStage: (stage: Stage) => void;
  setTool: (tool: Tool) => void;
  addDraftVert: (v: DraftVert) => void;
  /** Backspace while drawing: drop the last vertex, keep drawing. */
  popDraftVert: () => void;
  finishDraft: (tolWorld: number) => void;
  cancelDraft: () => void;
  selectEdge: (id: string | null, mode?: boolean | SelectMode) => void;
  selectEdges: (ids: string[], mode: SelectMode) => void;
  selectAll: () => void;
  fitAll: () => void;
  removeEdges: (ids: string[]) => void;
  setDesignOpacity: (v: number) => void;
  moveVertex: (edgeId: string, idx: number, x: number, y: number) => void;
  removeVertex: (edgeId: string, idx: number) => void;
  flipSection: (edgeId: string) => void;
  mergeSelectedAsDc: () => void;
  removeEdge: (id: string) => void;
  removeNode: (id: string) => void;
  assignSection: (edgeId: string, catalogId: string | null) => void;
  assignSectionToSelected: (catalogId: string | null) => void;
  updateSectionComponents: (edgeId: string, components: SectionComponent[]) => void;
  updateSectionRef: (edgeId: string, refM: number) => void;
  removeNodeSmart: (nodeId: string) => void;
  autoAssign: () => void;
  dismissReview: (edgeId: string) => void;
  focusNode: (nodeId: string) => void;
  moveNodeTo: (id: string, x: number, y: number) => void;
  mergeNodePair: (keep: string, drop: string) => void;
  weldNodeToEdge: (nodeId: string, edgeId: string, x: number, y: number) => void;
  splitEdgeAt: (edgeId: string, x: number, y: number) => void;
  simplifyAll: (tolM: number) => void;
  cleanNetwork: () => void;
  importOsmBbox: () => Promise<void>;
  setImportFilter: (key: keyof ImportFilters, value: boolean) => void;
  setBoxDraw: (purpose: 'import' | 'export' | null) => void;
  setBox: (purpose: 'import' | 'export', b: Bounds | null) => void;
  loadSample: () => Promise<void>;
  scanDualCarriageways: () => void;
  applyDcMerge: (c: DcCandidate) => void;
  setHighlight: (ids: string[]) => void;
  setBasemap: (b: Basemap) => void;
  goTo: (p: LatLon, label: string) => void;
  setPlaceKind: (kind: ElementKind | null, variant?: string | null) => void;
  placeElementAt: (wx: number, wy: number, tolM: number) => void;
  moveElement: (id: string, wx: number, wy: number, tolM: number) => void;
  removeElement: (id: string) => void;
  selectElement: (id: string | null) => void;
  suggest: (kind: ElementKind, spacingM?: number) => void;
  setElementProp: (id: string, key: string, value: string | number | boolean) => void;
  clearSuggestions: () => void;
  setEdgeLanes: (edgeId: string, lanes: number) => void;
  /** Auto lane counts from carriageway width (3.25 m lanes) → dashed dividers. */
  suggestLanes: () => void;
  selectJunction: (key: string | null) => void;
  setBoundaryDraw: (on: boolean) => void;
  addBoundaryVert: (x: number, y: number) => void;
  finishBoundary: () => void;
  cancelBoundary: () => void;
  removeBoundary: (id: string) => void;
  selectBoundary: (id: string | null) => void;
  moveBoundaryVertex: (id: string, idx: number, x: number, y: number) => void;
  removeBoundaryVertex: (id: string, idx: number) => void;
  setPatchKind: (kind: PatchKind | null) => void;
  addPatchVert: (x: number, y: number) => void;
  finishPatch: () => void;
  cancelPatch: () => void;
  removePatch: (id: string) => void;
  selectPatch: (id: string | null) => void;
  movePatchVertex: (id: string, idx: number, x: number, y: number) => void;
  removePatchVertex: (id: string, idx: number) => void;
  undo: () => void;
  redo: () => void;
  pruneSelections: () => void;
  setJunctionType: (jKey: string, type: JunctionType) => void;
  setCornerRadius: (jKey: string, cornerKey: string, radiusM: number | null) => void;
  toggleCornerChamfer: (jKey: string, cornerKey: string) => void;
  setApproachTrim: (jKey: string, approachKey: string, trimM: number | null) => void;
  removeJunctionDesign: (jKey: string) => void;
  selectShape: (key: string | null) => void;
  setVertexDelta: (shapeKey: string, key: string, delta: VertexDelta) => void;
  removeVertexDelta: (shapeKey: string, key: string) => void;
  clearShapeOverrides: (shapeKey: string) => void;
  setMeshDelta: (nodeKey: string, dx: number, dy: number) => void;
  removeMeshDelta: (nodeKey: string) => void;
  clearMeshEdits: () => void;
  /** Replace the whole design with a saved/restored document (undo history resets). */
  loadDocument: (raw: unknown, label?: string) => void;
  /** Start over: empty graph, empty overlays, autosave cleared. */
  clearAll: () => void;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  toggleLayer: (key: LayerKey) => void;
}

const EMPTY_DESIGN: JunctionDesign = {
  type: 'priority',
  cornerOverrides: {},
  approachOverrides: {},
  touched: false,
};

function pickGraph(s: CstState): GraphState {
  return { nodes: s.nodes, edges: s.edges, nextNodeNum: s.nextNodeNum, nextEdgeNum: s.nextEdgeNum };
}

/** Re-anchor elements after `oldEdge` was split at `nodeId` into two new edges. */
function reanchorAfterSplit(
  elements: CstState['elements'],
  oldEdge: StreetEdge,
  g: GraphState,
  nodeId: string,
): CstState['elements'] {
  const n = g.nodes[nodeId];
  if (!n) return elements;
  const halves = Object.values(g.edges).filter(
    (e) => (e.a === oldEdge.a && e.b === nodeId) || (e.a === nodeId && e.b === oldEdge.b),
  );
  const first = halves.find((e) => e.a === oldEdge.a && e.b === nodeId);
  const second = halves.find((e) => e.a === nodeId && e.b === oldEdge.b);
  if (!first || !second) return elements;
  const splitStation = projectOnPolyline(oldEdge.points, n.x, n.y)?.station ?? 0;
  const out: CstState['elements'] = {};
  let changed = false;
  for (const [id, el] of Object.entries(elements)) {
    if (el.edgeId !== oldEdge.id) {
      out[id] = el;
      continue;
    }
    changed = true;
    out[id] =
      el.stationM <= splitStation
        ? { ...el, edgeId: first.id }
        : { ...el, edgeId: second.id, stationM: el.stationM - splitStation };
  }
  return changed ? out : elements;
}

export const useCst = create<CstState>()(
  temporal(
    (set, get) => ({
      ...EMPTY_GRAPH,
      stage: 'network',
      tool: 'select',
      // Anchored from the start so the basemap is visible on load; imports and
      // (on an empty graph) geocoding re-anchor it.
      origin: { lat: DEFAULT_IMPORT.lat, lon: DEFAULT_IMPORT.lon },
      basemap: 'osm',
      selectedEdgeId: null,
      selectedEdgeIds: [],
      junctionDesigns: {},
      selectedJunctionKey: null,
      elements: {},
      nextElementNum: 1,
      placeKind: null,
      placeVariant: null,
      selectedElementId: null,
      boundaries: {},
      nextBoundaryNum: 1,
      boundaryDraw: false,
      boundaryDraft: [],
      selectedBoundaryId: null,
      vertexOverrides: {},
      meshEdits: {},
      selectedShapeKey: null,
      patches: {},
      nextPatchNum: 1,
      patchKind: null,
      patchDraft: [],
      selectedPatchId: null,
      boxDraw: null,
      importBox: null,
      exportBounds: null,
      importFilters: { ...DEFAULT_FILTERS },
      busStops: [],
      designOpacity: 1,
      draft: [],
      dcCandidates: null,
      highlightEdges: [],
      pendingFit: null,
      statusMsg: '',
      importBusy: false,
      reviewList: [],
      settings: readSettings(),
      layers: { ...DEFAULT_LAYERS },

      setStage: (stage) => {
        // Leaving any stage drops all transient drawing/placement modes so
        // nothing (a half-drawn patch, an armed material, an unfinished box)
        // leaks into the next stage where it has no meaning.
        set({
          stage,
          tool: 'select',
          draft: [],
          highlightEdges: [],
          boxDraw: null,
          boundaryDraw: false,
          boundaryDraft: [],
          patchDraft: [],
          patchKind: null,
          placeKind: null,
          selectedShapeKey: null,
        });
        // First entry into Sections with unassigned tagged edges → auto-assign
        // + review list (Plan v2 §3.3), never overwriting existing work.
        if (stage === 'sections') {
          const s = get();
          const edges = Object.values(s.edges);
          // Only on a FRESH graph (nothing assigned yet) — re-running on every
          // tab switch would resurrect review items the user dismissed.
          const fresh = edges.length > 0 && edges.every((e) => !e.section) && edges.some((e) => e.highway);
          if (fresh) get().autoAssign();
        }
      },
      // Picking a tool exits box-draw and boundary-trace modes; arming either
      // mode (setBoxDraw/setBoundaryDraw) forces the select tool. Together
      // these keep the drawing modes and the tools mutually exclusive, so one
      // gesture can never trigger two modes.
      setTool: (tool) =>
        set((s) => ({
          tool,
          boxDraw: null,
          boundaryDraw: false,
          boundaryDraft: [],
          draft: tool === 'draw' ? s.draft : [],
        })),

      addDraftVert: (v) => set((s) => ({ draft: [...s.draft, v] })),

      popDraftVert: () => set((s) => ({ draft: s.draft.slice(0, -1) })),

      finishDraft: (tolWorld) => {
        const s = get();
        const { g, created } = commitDraft(pickGraph(s), s.draft, tolWorld);
        set({
          ...g,
          draft: [],
          dcCandidates: null,
          statusMsg: created ? `${created} street segment(s) added` : '',
        });
      },

      cancelDraft: () => set({ draft: [] }),
      selectEdge: (id, mode) =>
        set((s) => {
          const m = mode === true ? 'toggle' : mode || 'replace';
          if (m === 'replace' || !id) {
            return { selectedEdgeId: id, selectedEdgeIds: id ? [id] : [] };
          }
          const has = s.selectedEdgeIds.includes(id);
          if (m === 'add' && has) return { selectedEdgeId: id };
          const ids = has ? s.selectedEdgeIds.filter((x) => x !== id) : [...s.selectedEdgeIds, id];
          return { selectedEdgeIds: ids, selectedEdgeId: has ? (ids[ids.length - 1] ?? null) : id };
        }),

      selectEdges: (newIds, mode) =>
        set((s) => {
          let ids: string[];
          if (mode === 'add') ids = [...new Set([...s.selectedEdgeIds, ...newIds])];
          else if (mode === 'toggle') {
            const cur = new Set(s.selectedEdgeIds);
            for (const id of newIds) {
              if (cur.has(id)) cur.delete(id);
              else cur.add(id);
            }
            ids = [...cur];
          } else ids = newIds;
          return {
            selectedEdgeIds: ids,
            selectedEdgeId: ids[ids.length - 1] ?? null,
            statusMsg: ids.length ? `${ids.length} street(s) selected` : '',
          };
        }),

      selectAll: () =>
        set((s) => {
          const ids = Object.keys(s.edges);
          return { selectedEdgeIds: ids, selectedEdgeId: ids[ids.length - 1] ?? null };
        }),

      fitAll: () =>
        set((s) => {
          const b = graphBounds(pickGraph(s));
          return b ? { pendingFit: b } : {};
        }),

      removeEdges: (ids) =>
        set((s) => {
          let g = pickGraph(s);
          for (const id of ids) g = deleteEdge(g, id);
          return {
            ...g,
            elements: pruneElements(g, s.elements),
            dcCandidates: null,
            highlightEdges: [],
            selectedEdgeId: null,
            selectedEdgeIds: [],
            statusMsg: `${ids.length} street(s) deleted`,
          };
        }),

      setDesignOpacity: (v) => set({ designOpacity: Math.max(0.15, Math.min(1, v)) }),

      moveVertex: (edgeId, idx, x, y) => set((s) => ({ ...moveEdgeVertex(pickGraph(s), edgeId, idx, x, y) })),

      removeVertex: (edgeId, idx) =>
        set((s) => ({ ...removeEdgeVertex(pickGraph(s), edgeId, idx), statusMsg: 'vertex removed' })),

      flipSection: (edgeId) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e?.section) return {};
          const total = e.section.components.reduce((sum, c) => sum + c.widthM, 0);
          const last = e.section.components.length - 1;
          const section = {
            ...e.section,
            components: [...e.section.components].reverse(),
            refM: total - (e.section.refM ?? total / 2),
          };
          // Elements anchored to this edge mirror with it (compIndex + fraction).
          const elements = Object.fromEntries(
            Object.entries(s.elements).map(([id, el]) =>
              el.edgeId === edgeId && el.compIndex >= 0
                ? [id, { ...el, compIndex: last - el.compIndex, t: 1 - el.t }]
                : [id, el],
            ),
          );
          return { edges: { ...s.edges, [edgeId]: { ...e, section } }, elements, statusMsg: 'section flipped' };
        }),

      mergeSelectedAsDc: () =>
        set((s) => {
          if (s.selectedEdgeIds.length !== 2) return { statusMsg: 'select exactly 2 parallel streets first' };
          const cand = manualDcCandidate(pickGraph(s), s.selectedEdgeIds[0], s.selectedEdgeIds[1]);
          if (typeof cand === 'string') return { statusMsg: cand };
          return {
            ...mergeDualCarriageway(pickGraph(s), cand),
            selectedEdgeId: null,
            selectedEdgeIds: [],
            dcCandidates: null,
            statusMsg: `Merged into a divided carriageway (separation ${cand.meanSepM.toFixed(1)} m)`,
          };
        }),

      removeEdge: (id) =>
        set((s) => ({
          ...deleteEdge(pickGraph(s), id),
          dcCandidates: null,
          highlightEdges: [],
          selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
          selectedEdgeIds: s.selectedEdgeIds.filter((x) => x !== id),
        })),

      removeNode: (id) => set((s) => ({ ...deleteNode(pickGraph(s), id), dcCandidates: null })),

      assignSection: (edgeId, catalogId) =>
        set((s) => {
          const cat = getSection(catalogId);
          const section = cat ? materialize(cat) : null;
          const e = s.edges[edgeId];
          if (!e) return {};
          return {
            edges: { ...s.edges, [edgeId]: { ...e, section } },
            reviewList: s.reviewList.filter((r) => r.edgeId !== edgeId),
          };
        }),

      assignSectionToSelected: (catalogId) =>
        set((s) => {
          const ids = s.selectedEdgeIds.filter((id) => s.edges[id]);
          if (ids.length === 0) return {};
          const cat = getSection(catalogId);
          const edges = { ...s.edges };
          for (const id of ids) {
            edges[id] = { ...edges[id], section: cat ? materialize(cat) : null };
          }
          return {
            edges,
            reviewList: s.reviewList.filter((r) => !ids.includes(r.edgeId)),
            statusMsg:
              ids.length > 1
                ? `section ${cat ? 'applied to' : 'removed from'} ${ids.length} streets`
                : '',
          };
        }),

      updateSectionComponents: (edgeId, components) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e?.section) return {};
          return {
            edges: {
              ...s.edges,
              [edgeId]: { ...e, section: { ...e.section, components } },
            },
          };
        }),

      autoAssign: () =>
        set((s) => {
          const { assigned, review } = autoAssignSections(pickGraph(s));
          const n = Object.keys(assigned).length;
          if (n === 0 && review.length === 0) return {};
          const edges = { ...s.edges };
          for (const [id, section] of Object.entries(assigned)) {
            edges[id] = { ...edges[id], section };
          }
          return {
            edges,
            reviewList: review,
            statusMsg: `${n} section(s) auto-assigned from highway class · ${review.length} to review`,
          };
        }),

      dismissReview: (edgeId) =>
        set((s) => ({ reviewList: s.reviewList.filter((r) => r.edgeId !== edgeId) })),

      updateSectionRef: (edgeId, refM) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e?.section) return {};
          const total = e.section.components.reduce((sum, c) => sum + c.widthM, 0);
          const clamped = Math.max(0, Math.min(total, refM));
          return {
            edges: { ...s.edges, [edgeId]: { ...e, section: { ...e.section, refM: clamped } } },
          };
        }),

      // Right-click delete: terminus/junction nodes go with their edges;
      // a degree-2 node heals — its two streets join without the bend.
      removeNodeSmart: (nodeId) =>
        set((s) => {
          const g = pickGraph(s);
          const deg = Object.values(s.edges).reduce(
            (d, e) => d + (e.a === nodeId ? 1 : 0) + (e.b === nodeId ? 1 : 0),
            0,
          );
          if (deg === 2) {
            const healed = joinThroughNode(g, nodeId);
            if (healed) {
              // Elements follow the join: the kept edge may be reversed, the
              // dropped edge's stations shift past the kept edge's length.
              const { keptId, dropId, len1, len2, e1Reversed, e2Reversed } = healed;
              const kept = healed.g.edges[keptId];
              const lastComp = (kept.section?.components.length ?? 0) - 1;
              const mirror = (el: StreetElement) =>
                el.compIndex >= 0 && lastComp >= 0
                  ? { compIndex: lastComp - el.compIndex, t: 1 - el.t }
                  : {};
              const elements = Object.fromEntries(
                Object.entries(s.elements).map(([id, el]) => {
                  if (el.edgeId === keptId) {
                    return e1Reversed
                      ? [id, { ...el, stationM: len1 - el.stationM, ...mirror(el) }]
                      : [id, el];
                  }
                  if (el.edgeId === dropId) {
                    const stat = e2Reversed ? len2 - el.stationM : el.stationM;
                    return [
                      id,
                      { ...el, edgeId: keptId, stationM: len1 + stat, ...(e2Reversed ? mirror(el) : {}) },
                    ];
                  }
                  return [id, el];
                }),
              );
              return { ...healed.g, elements, dcCandidates: null, statusMsg: `${nodeId} removed — streets joined` };
            }
          }
          const gDel = deleteNode(g, nodeId);
          return {
            ...gDel,
            elements: pruneElements(gDel, s.elements),
            dcCandidates: null,
            selectedEdgeId: null,
            selectedEdgeIds: [],
            statusMsg: deg >= 3 ? `${nodeId} and its ${deg} streets removed — redraw as needed` : `${nodeId} removed`,
          };
        }),

      moveNodeTo: (id, x, y) => set((s) => ({ ...moveNode(pickGraph(s), id, x, y) })),

      mergeNodePair: (keep, drop) =>
        set((s) => ({ ...mergeNodes(pickGraph(s), keep, drop), statusMsg: `merged ${drop} into ${keep}` })),

      // Drop a node onto an edge: split the edge there and weld the node in
      // (one undoable step). The dragged node's streets rewire to the split point.
      weldNodeToEdge: (nodeId, edgeId, x, y) =>
        set((s) => {
          const oldEdge = s.edges[edgeId];
          const res = splitEdge(pickGraph(s), edgeId, x, y);
          if (!res.nodeId || res.nodeId === nodeId) return {};
          const elements = reanchorAfterSplit(s.elements, oldEdge, res.g, res.nodeId);
          const g = mergeNodes(res.g, res.nodeId, nodeId);
          return {
            ...g,
            elements: pruneElements(g, elements),
            dcCandidates: null,
            statusMsg: `${nodeId} welded into ${edgeId} at ${res.nodeId}`,
          };
        }),

      splitEdgeAt: (edgeId, x, y) =>
        set((s) => {
          const oldEdge = s.edges[edgeId];
          const res = splitEdge(pickGraph(s), edgeId, x, y);
          if (!res.nodeId) return {};
          return {
            ...res.g,
            elements: reanchorAfterSplit(s.elements, oldEdge, res.g, res.nodeId),
            statusMsg: `split at ${res.nodeId}`,
          };
        }),

      simplifyAll: (tolM) =>
        set((s) => {
          const { g, removed } = simplifyEdges(pickGraph(s), tolM);
          return { ...g, statusMsg: `${removed} vertex/vertices removed` };
        }),

      cleanNetwork: () =>
        set((s) => {
          const { g, summary } = runStandardPipeline(pickGraph(s));
          return { ...g, elements: pruneElements(g, s.elements), dcCandidates: null, statusMsg: summary };
        }),

      loadSample: async () => {
        set({ importBusy: true, statusMsg: 'Loading Pune sample…' });
        const data = (await import('./data/pune-sample.json')).default as unknown as Parameters<typeof parseOsm>[0];
        const g = parseOsm(data, DEFAULT_IMPORT);
        const cleaned = runStandardPipeline(g);
        set({
          ...cleaned.g,
          origin: { lat: DEFAULT_IMPORT.lat, lon: DEFAULT_IMPORT.lon },
          busStops: parseBusStops(data, DEFAULT_IMPORT),
          importBusy: false,
          selectedEdgeId: null,
          selectedEdgeIds: [],
          selectedElementId: null,
          selectedJunctionKey: null,
          placeKind: null,
          elements: {},
          nextElementNum: 1,
          junctionDesigns: {},
          patches: {},
          nextPatchNum: 1,
          selectedPatchId: null,
          importBox: null,
          exportBounds: null,
          reviewList: [],
          dcCandidates: null,
          highlightEdges: [],
          pendingFit: graphBounds(cleaned.g),
          statusMsg: `Sample: ${Object.keys(cleaned.g.edges).length} edges / ${Object.keys(cleaned.g.nodes).length} nodes (${cleaned.summary})`,
        });
      },

      setImportFilter: (key, value) =>
        set((s) => ({ importFilters: { ...s.importFilters, [key]: value } })),

      setBoxDraw: (purpose) =>
        set({
          boxDraw: purpose,
          tool: 'select', // box-draw and the drawing tools are mutually exclusive
          boundaryDraw: false,
          boundaryDraft: [],
          statusMsg: purpose ? `drag a rectangle on the canvas to set the ${purpose} area` : '',
        }),

      setBox: (purpose, b) =>
        set(purpose === 'import' ? { importBox: b, boxDraw: null } : { exportBounds: b, boxDraw: null }),

      importOsmBbox: async () => {
        const s = get();
        if (!s.importBox || !s.origin) return;
        const { minX, minY, maxX, maxY } = s.importBox;
        // y-down: minY is the NORTH edge
        const nw = toLatLon(s.origin, minX, minY);
        const se = toLatLon(s.origin, maxX, maxY);
        const center = toLatLon(s.origin, (minX + maxX) / 2, (minY + maxY) / 2);
        set({ importBusy: true, statusMsg: 'Fetching the selected area from Overpass…' });
        try {
          const data = await fetchOverpassBbox(se.lat, nw.lon, nw.lat, se.lon);
          const g = parseOsm(data, center, s.importFilters);
          const cleaned = runStandardPipeline(g);
          set({
            ...cleaned.g,
            origin: center,
            busStops: parseBusStops(data, center),
            importBusy: false,
            selectedEdgeId: null,
            selectedEdgeIds: [],
            selectedElementId: null,
            selectedJunctionKey: null,
            placeKind: null,
            elements: {},
            nextElementNum: 1,
            junctionDesigns: {},
            patches: {},
            nextPatchNum: 1,
            selectedPatchId: null,
            reviewList: [],
            dcCandidates: null,
            highlightEdges: [],
            importBox: null,
            exportBounds: null,
            pendingFit: graphBounds(cleaned.g),
            statusMsg: `Imported ${Object.keys(cleaned.g.edges).length} edges / ${Object.keys(cleaned.g.nodes).length} nodes (${cleaned.summary})`,
          });
        } catch (err) {
          set({ importBusy: false, statusMsg: `Import failed: ${(err as Error).message}` });
        }
      },

      scanDualCarriageways: () =>
        set((s) => {
          const found = detectDualCarriageways(pickGraph(s));
          return {
            dcCandidates: found,
            statusMsg: `${found.length} dual-carriageway candidate(s)`,
          };
        }),

      applyDcMerge: (c) =>
        set((s) => {
          const g = mergeDualCarriageway(pickGraph(s), c);
          return {
            ...g,
            elements: pruneElements(g, s.elements),
            dcCandidates: (s.dcCandidates ?? []).filter((x) => x !== c),
            highlightEdges: [],
            statusMsg: `Merged ${c.e1} + ${c.e2} into a divided carriageway`,
          };
        }),

      setHighlight: (ids) => set({ highlightEdges: ids }),

      setBasemap: (b) => set({ basemap: b }),

      goTo: (p, label) =>
        set((s) => {
          // With no design yet, re-anchor the origin at the searched place so
          // local coordinates (and projection accuracy) stay centered on it.
          if (!s.origin || Object.keys(s.edges).length === 0) {
            return {
              origin: p,
              // Boxes are world metres relative to the OLD origin — drop them
              // so they can't point at the wrong place after re-anchoring.
              importBox: null,
              exportBounds: null,
              boxDraw: null,
              pendingFit: { minX: -260, minY: -260, maxX: 260, maxY: 260 },
              statusMsg: `Centered on ${label}`,
            };
          }
          const { x, y } = toLocal(s.origin, p);
          return {
            pendingFit: { minX: x - 260, minY: y - 260, maxX: x + 260, maxY: y + 260 },
            statusMsg: `Centered on ${label} — importing here replaces the current network`,
          };
        }),

      focusNode: (nodeId) =>
        set((s) => {
          const n = s.nodes[nodeId];
          if (!n) return {};
          return {
            pendingFit: { minX: n.x - 60, minY: n.y - 60, maxX: n.x + 60, maxY: n.y + 60 },
          };
        }),

      setPlaceKind: (kind, variant = null) =>
        set({ placeKind: kind, placeVariant: variant, selectedElementId: null }),

      placeElementAt: (wx, wy, tolM) =>
        set((s) => {
          if (!s.placeKind) return {};
          const p = resolveDrop(pickGraph(s), s.placeKind, wx, wy, tolM);
          if (!p) return { statusMsg: `no eligible ${s.placeKind} location there` };
          const id = `x${s.nextElementNum}`;
          const el: StreetElement = {
            id,
            kind: s.placeKind,
            ...p,
            variant: s.placeVariant ?? undefined,
            widthM: DEFAULT_WIDTH[s.placeKind],
            placedBy: 'user',
          };
          return {
            elements: { ...s.elements, [id]: el },
            nextElementNum: s.nextElementNum + 1,
            selectedElementId: id,
            statusMsg: `${s.placeKind} placed`,
          };
        }),

      moveElement: (id, wx, wy, tolM) =>
        set((s) => {
          const el = s.elements[id];
          if (!el) return {};
          const p = resolveDrop(pickGraph(s), el.kind, wx, wy, tolM);
          if (!p) return {};
          return {
            elements: { ...s.elements, [id]: { ...el, ...p, placedBy: 'user' } },
          };
        }),

      removeElement: (id) =>
        set((s) => {
          const elements = { ...s.elements };
          delete elements[id];
          return {
            elements,
            selectedElementId: s.selectedElementId === id ? null : s.selectedElementId,
            statusMsg: 'element removed',
          };
        }),

      selectElement: (id) => set({ selectedElementId: id }),

      setElementProp: (id, key, value) =>
        set((s) => {
          const el = s.elements[id];
          if (!el) return {};
          return {
            elements: { ...s.elements, [id]: { ...el, props: { ...el.props, [key]: value } } },
          };
        }),

      suggest: (kind, spacingM) =>
        set((s) => {
          const { trims } = deriveNodeArtifactsCached(pickGraph(s), s.junctionDesigns, s.settings.junctionBlend);
          const existing = Object.values(s.elements);
          const created =
            kind === 'zebra'
              ? suggestZebras(pickGraph(s), existing, trims)
              : kind === 'busstop'
                ? suggestBusStops(pickGraph(s), s.busStops, existing)
                : kind === 'turnarrow'
                  ? suggestTurnArrows(pickGraph(s), existing, trims, s.settings.drive)
                  : suggestElements(pickGraph(s), kind, existing, trims, spacingM);
          if (created.length === 0) {
            if (kind === 'busstop') {
              return {
                statusMsg:
                  s.busStops.length === 0
                    ? 'no bus stops in the OSM download — import an area that has some, or place them by hand'
                    : 'all downloaded bus stops are already covered',
              };
            }
            return { statusMsg: kind === 'zebra' ? 'no junction approaches need a crossing' : `no eligible belts for ${kind} suggestions` };
          }
          const elements = { ...s.elements };
          let n = s.nextElementNum;
          for (const el of created) {
            const id = `x${n++}`;
            elements[id] = { ...el, id };
          }
          return {
            elements,
            nextElementNum: n,
            statusMsg: `${created.length} ${kind}(s) suggested — drag to adjust, right-click to remove`,
          };
        }),

      clearSuggestions: () =>
        set((s) => {
          const elements = Object.fromEntries(
            Object.entries(s.elements).filter(([, el]) => el.placedBy !== 'suggest'),
          );
          const n = Object.keys(s.elements).length - Object.keys(elements).length;
          return { elements, statusMsg: `${n} suggestion(s) cleared` };
        }),

      setEdgeLanes: (edgeId, lanes) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e) return {};
          return {
            edges: {
              ...s.edges,
              [edgeId]: { ...e, lanes: lanes >= 2 ? Math.min(6, Math.round(lanes)) : undefined },
            },
          };
        }),

      suggestLanes: () =>
        set((s) => {
          const edges = { ...s.edges };
          let n = 0;
          for (const e of Object.values(s.edges)) {
            if (!e.section || e.lanes) continue;
            const w = Math.max(
              0,
              ...e.section.components
                .filter((c) => c.kind === 'carriageway' || c.kind === 'brt')
                .map((c) => c.widthM),
            );
            const lanes = Math.round(w / 3.25); // IRC urban lane width
            if (lanes >= 2) {
              edges[e.id] = { ...e, lanes: Math.min(4, lanes) };
              n++;
            }
          }
          return n
            ? { edges, statusMsg: `lane lines generated on ${n} street(s) — tune per street below` }
            : { statusMsg: 'no carriageways wide enough for extra lane lines' };
        }),

      selectJunction: (key) => set({ selectedJunctionKey: key }),

      setBoundaryDraw: (on) =>
        set({
          boundaryDraw: on,
          boundaryDraft: [],
          tool: 'select', // exclusive with the drawing tools, like box-draw
          boxDraw: null,
          selectedBoundaryId: null,
          statusMsg: on ? 'click along the plot/compound-wall line · double-click or Enter finishes' : '',
        }),

      addBoundaryVert: (x, y) => set((s) => ({ boundaryDraft: [...s.boundaryDraft, x, y] })),

      finishBoundary: () =>
        set((s) => {
          let pts = s.boundaryDraft;
          // A finishing double-click leaves a duplicated tail vertex — trim it.
          while (
            pts.length >= 6 &&
            Math.hypot(pts[pts.length - 2] - pts[pts.length - 4], pts[pts.length - 1] - pts[pts.length - 3]) < 0.05
          ) {
            pts = pts.slice(0, -2);
          }
          if (pts.length < 4) return { boundaryDraft: [] };
          const id = `b${s.nextBoundaryNum}`;
          return {
            boundaries: { ...s.boundaries, [id]: { id, points: pts } },
            nextBoundaryNum: s.nextBoundaryNum + 1,
            boundaryDraft: [],
            selectedBoundaryId: id,
            statusMsg: 'boundary traced — drag its vertices to refine, right-click removes',
          };
        }),

      cancelBoundary: () => set({ boundaryDraft: [], boundaryDraw: false }),

      removeBoundary: (id) =>
        set((s) => {
          const boundaries = { ...s.boundaries };
          delete boundaries[id];
          return {
            boundaries,
            selectedBoundaryId: s.selectedBoundaryId === id ? null : s.selectedBoundaryId,
            statusMsg: 'boundary removed',
          };
        }),

      selectBoundary: (id) => set({ selectedBoundaryId: id }),

      moveBoundaryVertex: (id, idx, x, y) =>
        set((s) => {
          const b = s.boundaries[id];
          if (!b || idx < 0 || idx * 2 >= b.points.length) return {};
          const points = b.points.slice();
          points[idx * 2] = x;
          points[idx * 2 + 1] = y;
          return { boundaries: { ...s.boundaries, [id]: { ...b, points } } };
        }),

      removeBoundaryVertex: (id, idx) =>
        set((s) => {
          const b = s.boundaries[id];
          if (!b || b.points.length <= 4) return {};
          const points = b.points.slice();
          points.splice(idx * 2, 2);
          return { boundaries: { ...s.boundaries, [id]: { ...b, points } } };
        }),

      setPatchKind: (kind) => set({ patchKind: kind, patchDraft: [], selectedPatchId: null }),

      addPatchVert: (x, y) => set((s) => ({ patchDraft: [...s.patchDraft, x, y] })),

      finishPatch: () =>
        set((s) => {
          if (s.patchDraft.length < 6 || !s.patchKind) return { patchDraft: [] };
          const id = `p${s.nextPatchNum}`;
          return {
            patches: { ...s.patches, [id]: { id, kind: s.patchKind, points: s.patchDraft } },
            nextPatchNum: s.nextPatchNum + 1,
            patchDraft: [],
            selectedPatchId: id,
            statusMsg: `${s.patchKind} patch added — drag its vertices to refine`,
          };
        }),

      cancelPatch: () => set({ patchDraft: [] }),

      removePatch: (id) =>
        set((s) => {
          const patches = { ...s.patches };
          delete patches[id];
          return {
            patches,
            selectedPatchId: s.selectedPatchId === id ? null : s.selectedPatchId,
            statusMsg: 'patch removed',
          };
        }),

      selectPatch: (id) => set({ selectedPatchId: id }),

      movePatchVertex: (id, idx, x, y) =>
        set((s) => {
          const p = s.patches[id];
          if (!p || idx < 0 || idx * 2 >= p.points.length) return {};
          const points = p.points.slice();
          points[idx * 2] = x;
          points[idx * 2 + 1] = y;
          return { patches: { ...s.patches, [id]: { ...p, points } } };
        }),

      removePatchVertex: (id, idx) =>
        set((s) => {
          const p = s.patches[id];
          if (!p || p.points.length <= 6) return {};
          const points = p.points.slice();
          points.splice(idx * 2, 2);
          return { patches: { ...s.patches, [id]: { ...p, points } } };
        }),

      // Undo/redo restore the graph slice only; volatile selections must be
      // re-validated against the restored records or they dangle (§7 of
      // ARCHITECTURE.md). Always undo through these, never temporal directly.
      undo: () => {
        useCst.temporal.getState().undo();
        get().pruneSelections();
      },

      redo: () => {
        useCst.temporal.getState().redo();
        get().pruneSelections();
      },

      pruneSelections: () =>
        set((s) => {
          const ids = s.selectedEdgeIds.filter((id) => s.edges[id]);
          const junctionAlive =
            s.selectedJunctionKey?.split('+').every((nid) => s.nodes[nid]) ?? false;
          return {
            // Derived UI lists describe the pre-undo world — reconcile/clear.
            reviewList: s.reviewList.filter((r) => s.edges[r.edgeId] && !s.edges[r.edgeId].section),
            dcCandidates: null,
            selectedEdgeIds: ids,
            selectedEdgeId: s.selectedEdgeId && s.edges[s.selectedEdgeId] ? s.selectedEdgeId : ids[ids.length - 1] ?? null,
            selectedElementId:
              s.selectedElementId && s.elements[s.selectedElementId] ? s.selectedElementId : null,
            selectedPatchId:
              s.selectedPatchId && s.patches[s.selectedPatchId] ? s.selectedPatchId : null,
            selectedBoundaryId:
              s.selectedBoundaryId && s.boundaries[s.selectedBoundaryId] ? s.selectedBoundaryId : null,
            selectedJunctionKey: junctionAlive ? s.selectedJunctionKey : null,
          };
        }),

      setJunctionType: (jKey, type) =>
        set((s) => ({
          junctionDesigns: {
            ...s.junctionDesigns,
            [jKey]: { ...(s.junctionDesigns[jKey] ?? EMPTY_DESIGN), type, touched: true },
          },
        })),

      setCornerRadius: (jKey, cornerKey, radiusM) =>
        set((s) => {
          const d = s.junctionDesigns[jKey] ?? EMPTY_DESIGN;
          const cornerOverrides = { ...d.cornerOverrides };
          if (radiusM === null) delete cornerOverrides[cornerKey];
          else cornerOverrides[cornerKey] = { ...cornerOverrides[cornerKey], radiusM, chamfer: false };
          return {
            junctionDesigns: { ...s.junctionDesigns, [jKey]: { ...d, cornerOverrides, touched: true } },
            statusMsg: radiusM === null ? 'corner reset' : `corner radius ${radiusM.toFixed(1)} m`,
          };
        }),

      toggleCornerChamfer: (jKey, cornerKey) =>
        set((s) => {
          const d = s.junctionDesigns[jKey] ?? EMPTY_DESIGN;
          const prev = d.cornerOverrides[cornerKey];
          const cornerOverrides = {
            ...d.cornerOverrides,
            [cornerKey]: { ...prev, chamfer: !prev?.chamfer },
          };
          return {
            junctionDesigns: { ...s.junctionDesigns, [jKey]: { ...d, cornerOverrides, touched: true } },
            statusMsg: cornerOverrides[cornerKey].chamfer ? 'corner chamfered' : 'corner filleted',
          };
        }),

      setApproachTrim: (jKey, approachKey, trimM) =>
        set((s) => {
          const d = s.junctionDesigns[jKey] ?? EMPTY_DESIGN;
          const approachOverrides = { ...d.approachOverrides };
          if (trimM === null) delete approachOverrides[approachKey];
          else approachOverrides[approachKey] = { trimM };
          return {
            junctionDesigns: { ...s.junctionDesigns, [jKey]: { ...d, approachOverrides, touched: true } },
            statusMsg: trimM === null ? 'approach reset' : `approach trim ${trimM.toFixed(1)} m`,
          };
        }),

      removeJunctionDesign: (jKey) =>
        set((s) => {
          const junctionDesigns = { ...s.junctionDesigns };
          delete junctionDesigns[jKey];
          return { junctionDesigns, statusMsg: 'junction overrides removed' };
        }),

      setSetting: (key, value) =>
        set((s) => {
          const settings = { ...s.settings, [key]: value };
          try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
          } catch {
            // storage unavailable — settings stay session-local
          }
          return { settings };
        }),

      toggleLayer: (key) =>
        set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),

      selectShape: (key) => set({ selectedShapeKey: key }),

      setVertexDelta: (shapeKey, key, delta) =>
        set((s) => ({
          vertexOverrides: {
            ...s.vertexOverrides,
            [shapeKey]: { ...s.vertexOverrides[shapeKey], [key]: delta },
          },
        })),

      removeVertexDelta: (shapeKey, key) =>
        set((s) => {
          const shape = s.vertexOverrides[shapeKey];
          if (!shape || !(key in shape)) return {};
          const next = { ...shape };
          delete next[key];
          const vertexOverrides = { ...s.vertexOverrides };
          if (Object.keys(next).length === 0) delete vertexOverrides[shapeKey];
          else vertexOverrides[shapeKey] = next;
          return { vertexOverrides, statusMsg: 'vertex reset' };
        }),

      clearShapeOverrides: (shapeKey) =>
        set((s) => {
          if (!s.vertexOverrides[shapeKey]) return {};
          const vertexOverrides = { ...s.vertexOverrides };
          delete vertexOverrides[shapeKey];
          return { vertexOverrides, statusMsg: 'shape reset to generated geometry' };
        }),

      setMeshDelta: (nodeKey, dx, dy) =>
        set((s) => ({ meshEdits: { ...s.meshEdits, [nodeKey]: { dx, dy } } })),

      removeMeshDelta: (nodeKey) =>
        set((s) => {
          if (!(nodeKey in s.meshEdits)) return {};
          const meshEdits = { ...s.meshEdits };
          delete meshEdits[nodeKey];
          return { meshEdits, statusMsg: 'mesh node reset' };
        }),

      clearMeshEdits: () =>
        set((s) =>
          Object.keys(s.meshEdits).length === 0
            ? {}
            : { meshEdits: {}, statusMsg: 'mesh edits reset to generated geometry' },
        ),

      loadDocument: (raw, label = 'design') => {
        const slice = fromDocument(raw);
        if (typeof slice === 'string') {
          set({ statusMsg: `Open failed: ${slice}` });
          return;
        }
        set({
          ...slice,
          selectedEdgeId: null,
          selectedEdgeIds: [],
          selectedElementId: null,
          selectedJunctionKey: null,
          selectedPatchId: null,
          selectedBoundaryId: null,
          selectedShapeKey: null,
          placeKind: null,
          patchKind: null,
          patchDraft: [],
          draft: [],
          boundaryDraw: false,
          boundaryDraft: [],
          boxDraw: null,
          importBox: null,
          exportBounds: null,
          reviewList: [],
          dcCandidates: null,
          highlightEdges: [],
          pendingFit: graphBounds(slice),
          statusMsg: `${label} loaded — ${Object.keys(slice.edges).length} street(s)`,
        });
        // A loaded document is a new baseline; undoing past it would resurrect
        // the previous design's graph under the new origin.
        useCst.temporal.getState().clear();
      },

      clearAll: () => {
        clearAutosave();
        set({
          ...EMPTY_GRAPH,
          // keep origin/basemap: "new design here" rather than losing the anchor
          junctionDesigns: {},
          elements: {},
          nextElementNum: 1,
          patches: {},
          nextPatchNum: 1,
          boundaries: {},
          nextBoundaryNum: 1,
          boundaryDraw: false,
          boundaryDraft: [],
          selectedBoundaryId: null,
          vertexOverrides: {},
          meshEdits: {},
          selectedShapeKey: null,
          busStops: [],
          selectedEdgeId: null,
          selectedEdgeIds: [],
          selectedElementId: null,
          selectedJunctionKey: null,
          selectedPatchId: null,
          placeKind: null,
          patchKind: null,
          patchDraft: [],
          draft: [],
          boxDraw: null,
          importBox: null,
          exportBounds: null,
          reviewList: [],
          dcCandidates: null,
          highlightEdges: [],
          statusMsg: 'new design',
        });
        useCst.temporal.getState().clear();
      },
    }),
    {
      // Only the graph core participates in undo history.
      partialize: (s) => ({
        nodes: s.nodes,
        edges: s.edges,
        nextNodeNum: s.nextNodeNum,
        nextEdgeNum: s.nextEdgeNum,
        origin: s.origin,
        // selectedEdgeId is NOT persisted — it is derived from selectedEdgeIds
        // by pruneSelections after undo, so the two can never drift apart.
        junctionDesigns: s.junctionDesigns,
        elements: s.elements,
        nextElementNum: s.nextElementNum,
        patches: s.patches,
        nextPatchNum: s.nextPatchNum,
        boundaries: s.boundaries,
        nextBoundaryNum: s.nextBoundaryNum,
        vertexOverrides: s.vertexOverrides,
        meshEdits: s.meshEdits,
      }),
      equality: (a, b) =>
        a.nodes === b.nodes &&
        a.edges === b.edges &&
        a.junctionDesigns === b.junctionDesigns &&
        a.elements === b.elements &&
        a.patches === b.patches &&
        a.boundaries === b.boundaries &&
        a.vertexOverrides === b.vertexOverrides &&
        a.meshEdits === b.meshEdits,
      limit: 100,
    },
  ),
);

export { DEFAULT_IMPORT };

// ── Autosave ──────────────────────────────────────────────────────────────
// Debounced localStorage mirror of the document slice; restored on load when
// the session starts empty. Guarded so the store stays importable in node.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  const restored = readAutosave();
  if (restored && Object.keys(restored.edges).length > 0) {
    useCst.setState({
      ...restored,
      pendingFit: graphBounds(restored),
      statusMsg: `restored your last session — ${Object.keys(restored.edges).length} street(s)`,
    });
    useCst.temporal.getState().clear();
  }

  let saveTimer: number | undefined;
  useCst.subscribe((s, prev) => {
    // Only document data schedules a save — transient UI churn doesn't.
    if (
      s.nodes === prev.nodes &&
      s.edges === prev.edges &&
      s.origin === prev.origin &&
      s.junctionDesigns === prev.junctionDesigns &&
      s.elements === prev.elements &&
      s.patches === prev.patches &&
      s.boundaries === prev.boundaries &&
      s.vertexOverrides === prev.vertexOverrides &&
      s.meshEdits === prev.meshEdits &&
      s.busStops === prev.busStops
    ) {
      return;
    }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => writeAutosave(useCst.getState()), 800);
  });
}

// Dev-only handle for Playwright drives and console debugging (guard `window`
// so the store is importable in the node test environment).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__cst = useCst;
}
