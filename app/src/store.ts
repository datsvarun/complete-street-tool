import { create } from 'zustand';
import { temporal } from 'zundo';
import type { DcCandidate, DraftVert, GraphState, ReviewItem, SectionComponent, Stage, Tool } from './types';
import {
  commitDraft,
  deleteEdge,
  deleteNode,
  EMPTY_GRAPH,
  mergeNodes,
  moveNode,
  simplifyEdges,
  splitEdge,
} from './graph/ops';
import { runStandardPipeline } from './graph/transforms';
import { detectDualCarriageways, mergeDualCarriageway } from './graph/dualCarriageway';
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
  selectedEdgeId: string | null;
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
  selectEdge: (id: string | null) => void;
  removeEdge: (id: string) => void;
  removeNode: (id: string) => void;
  assignSection: (edgeId: string, catalogId: string | null) => void;
  updateSectionComponents: (edgeId: string, components: SectionComponent[]) => void;
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
}

function graphBounds(g: GraphState): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of Object.values(g.nodes)) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function pickGraph(s: CstState): GraphState {
  return { nodes: s.nodes, edges: s.edges, nextNodeNum: s.nextNodeNum, nextEdgeNum: s.nextEdgeNum };
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
      selectEdge: (id) => set({ selectedEdgeId: id }),

      removeEdge: (id) =>
        set((s) => ({
          ...deleteEdge(pickGraph(s), id),
          dcCandidates: null,
          highlightEdges: [],
          selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
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

      moveNodeTo: (id, x, y) => set((s) => ({ ...moveNode(pickGraph(s), id, x, y) })),

      mergeNodePair: (keep, drop) =>
        set((s) => ({ ...mergeNodes(pickGraph(s), keep, drop), statusMsg: `merged ${drop} into ${keep}` })),

      // Drop a node onto an edge: split the edge there and weld the node in
      // (one undoable step). The dragged node's streets rewire to the split point.
      weldNodeToEdge: (nodeId, edgeId, x, y) =>
        set((s) => {
          const res = splitEdge(pickGraph(s), edgeId, x, y);
          if (!res.nodeId || res.nodeId === nodeId) return {};
          const g = mergeNodes(res.g, res.nodeId, nodeId);
          return { ...g, dcCandidates: null, statusMsg: `${nodeId} welded into ${edgeId} at ${res.nodeId}` };
        }),

      splitEdgeAt: (edgeId, x, y) =>
        set((s) => {
          const res = splitEdge(pickGraph(s), edgeId, x, y);
          return res.nodeId ? { ...res.g, statusMsg: `split at ${res.nodeId}` } : {};
        }),

      simplifyAll: (tolM) =>
        set((s) => {
          const { g, removed } = simplifyEdges(pickGraph(s), tolM);
          return { ...g, statusMsg: `${removed} vertex/vertices removed` };
        }),

      cleanNetwork: () =>
        set((s) => {
          const { g, summary } = runStandardPipeline(pickGraph(s));
          return { ...g, dcCandidates: null, statusMsg: summary };
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
        set((s) => ({
          ...mergeDualCarriageway(pickGraph(s), c),
          dcCandidates: (s.dcCandidates ?? []).filter((x) => x !== c),
          highlightEdges: [],
          statusMsg: `Merged ${c.e1} + ${c.e2} into a divided carriageway`,
        })),

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
      }),
      equality: (a, b) => a.nodes === b.nodes && a.edges === b.edges,
      limit: 100,
    },
  ),
);

export { DEFAULT_IMPORT };
