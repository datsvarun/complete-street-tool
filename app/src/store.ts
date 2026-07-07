import { create } from 'zustand';
import { temporal } from 'zundo';
import type {
  DcCandidate,
  DraftVert,
  ElementKind,
  GraphState,
  JunctionDesign,
  JunctionType,
  ReviewItem,
  SectionComponent,
  SelectMode,
  Stage,
  StreetEdge,
  StreetElement,
  Tool,
} from './types';
import { DEFAULT_WIDTH, pruneElements, resolveDrop, suggestElements } from './detailing/elements';
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
import { fetchOverpass, parseOsm, toLocal, DEFAULT_IMPORT } from './osm/overpass';
import type { LatLon } from './osm/overpass';
import { getSection } from './catalog';
import { autoAssignSections, materialize } from './sections/rules';

// One shared store across all stages; stage is a UI mode, not a data boundary
// (Plan v2 §1.1). The graph core (nodes/edges) is the undoable slice.

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export type Basemap = 'none' | 'osm' | 'sat';

interface CstState extends GraphState {
  stage: Stage;
  tool: Tool;
  /** Projection origin: lat/lon of local (0,0). Set by import or geocoding. */
  origin: LatLon | null;
  basemap: Basemap;
  /** Last geocoded place — NetworkPanel syncs its import fields to this. */
  importTarget: LatLon | null;
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
  designOpacity: number;              // 0.2–1, sections/junctions layer alpha
  draft: DraftVert[];
  dcCandidates: DcCandidate[] | null; // null = not scanned yet
  highlightEdges: string[];
  pendingFit: Bounds | null;
  statusMsg: string;
  importBusy: boolean;
  reviewList: ReviewItem[];

  setStage: (stage: Stage) => void;
  setTool: (tool: Tool) => void;
  addDraftVert: (v: DraftVert) => void;
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
  importOsm: (lat: number, lon: number, radiusM: number) => Promise<void>;
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
  suggest: (kind: ElementKind) => void;
  clearSuggestions: () => void;
  setEdgeLanes: (edgeId: string, lanes: number) => void;
  selectJunction: (key: string | null) => void;
  undo: () => void;
  redo: () => void;
  pruneSelections: () => void;
  setJunctionType: (jKey: string, type: JunctionType) => void;
  setCornerRadius: (jKey: string, cornerKey: string, radiusM: number | null) => void;
  toggleCornerChamfer: (jKey: string, cornerKey: string) => void;
  setApproachTrim: (jKey: string, approachKey: string, trimM: number | null) => void;
  removeJunctionDesign: (jKey: string) => void;
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
      importTarget: null,
      selectedEdgeId: null,
      selectedEdgeIds: [],
      junctionDesigns: {},
      selectedJunctionKey: null,
      elements: {},
      nextElementNum: 1,
      placeKind: null,
      placeVariant: null,
      selectedElementId: null,
      designOpacity: 1,
      draft: [],
      dcCandidates: null,
      highlightEdges: [],
      pendingFit: null,
      statusMsg: '',
      importBusy: false,
      reviewList: [],

      setStage: (stage) => {
        set({ stage, tool: 'select', draft: [], highlightEdges: [] });
        // First entry into Sections with unassigned tagged edges → auto-assign
        // + review list (Plan v2 §3.3), never overwriting existing work.
        if (stage === 'sections') {
          const s = get();
          const hasUnassigned = Object.values(s.edges).some((e) => !e.section && e.highway);
          if (hasUnassigned) get().autoAssign();
        }
      },
      setTool: (tool) => set((s) => ({ tool, draft: tool === 'draw' ? s.draft : [] })),

      addDraftVert: (v) => set((s) => ({ draft: [...s.draft, v] })),

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

      importOsm: async (lat, lon, radiusM) => {
        set({ importBusy: true, statusMsg: 'Fetching from Overpass…' });
        try {
          const data = await fetchOverpass(lat, lon, radiusM);
          const g = parseOsm(data, { lat, lon });
          const cleaned = runStandardPipeline(g);
          set({
            ...cleaned.g,
            origin: { lat, lon },
            importBusy: false,
            selectedEdgeId: null,
            selectedEdgeIds: [],
            selectedElementId: null,
            selectedJunctionKey: null,
            placeKind: null,
            elements: {},
            nextElementNum: 1,
            junctionDesigns: {},
            reviewList: [],
            dcCandidates: null,
            highlightEdges: [],
            pendingFit: graphBounds(cleaned.g),
            statusMsg: `Imported ${Object.keys(cleaned.g.edges).length} edges / ${Object.keys(cleaned.g.nodes).length} nodes (${cleaned.summary})`,
          });
        } catch (err) {
          set({ importBusy: false, statusMsg: `Import failed: ${(err as Error).message}` });
        }
      },

      loadSample: async () => {
        set({ importBusy: true, statusMsg: 'Loading Pune sample…' });
        const data = (await import('./data/pune-sample.json')).default as unknown as Parameters<typeof parseOsm>[0];
        const g = parseOsm(data, DEFAULT_IMPORT);
        const cleaned = runStandardPipeline(g);
        set({
          ...cleaned.g,
          origin: { lat: DEFAULT_IMPORT.lat, lon: DEFAULT_IMPORT.lon },
          importBusy: false,
          selectedEdgeId: null,
          selectedEdgeIds: [],
          selectedElementId: null,
          selectedJunctionKey: null,
          placeKind: null,
          elements: {},
          nextElementNum: 1,
          junctionDesigns: {},
          reviewList: [],
          dcCandidates: null,
          highlightEdges: [],
          pendingFit: graphBounds(cleaned.g),
          statusMsg: `Sample: ${Object.keys(cleaned.g.edges).length} edges / ${Object.keys(cleaned.g.nodes).length} nodes (${cleaned.summary})`,
        });
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
              importTarget: p,
              pendingFit: { minX: -260, minY: -260, maxX: 260, maxY: 260 },
              statusMsg: `Centered on ${label}`,
            };
          }
          const { x, y } = toLocal(s.origin, p);
          return {
            importTarget: p,
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

      suggest: (kind) =>
        set((s) => {
          const { trims } = deriveNodeArtifactsCached(pickGraph(s), s.junctionDesigns);
          const created = suggestElements(pickGraph(s), kind, Object.values(s.elements), trims);
          if (created.length === 0) return { statusMsg: `no eligible belts for ${kind} suggestions` };
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

      selectJunction: (key) => set({ selectedJunctionKey: key }),

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
            selectedEdgeIds: ids,
            selectedEdgeId: s.selectedEdgeId && s.edges[s.selectedEdgeId] ? s.selectedEdgeId : ids[ids.length - 1] ?? null,
            selectedElementId:
              s.selectedElementId && s.elements[s.selectedElementId] ? s.selectedElementId : null,
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
    }),
    {
      // Only the graph core participates in undo history.
      partialize: (s) => ({
        nodes: s.nodes,
        edges: s.edges,
        nextNodeNum: s.nextNodeNum,
        nextEdgeNum: s.nextEdgeNum,
        origin: s.origin,
        selectedEdgeId: s.selectedEdgeId,
        junctionDesigns: s.junctionDesigns,
        elements: s.elements,
        nextElementNum: s.nextElementNum,
      }),
      equality: (a, b) =>
        a.nodes === b.nodes &&
        a.edges === b.edges &&
        a.junctionDesigns === b.junctionDesigns &&
        a.elements === b.elements,
      limit: 100,
    },
  ),
);

export { DEFAULT_IMPORT };

// Dev-only handle for Playwright drives and console debugging.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__cst = useCst;
}
