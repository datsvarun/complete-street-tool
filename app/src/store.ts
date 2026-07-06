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
import { fetchOverpass, parseOsm, DEFAULT_IMPORT } from './osm/overpass';
import { getSection } from './catalog';
import { autoAssignSections, materialize } from './sections/rules';
import { polylineLength } from './geometry/polyline';

// One shared store across all stages; stage is a UI mode, not a data boundary
// (Plan v2 §1.1). The graph core (nodes/edges) is the undoable slice.

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

interface CstState extends GraphState {
  stage: Stage;
  tool: Tool;
  selectedEdgeId: string | null;
  draft: DraftVert[];
  selectedOverrideId: string | null; // section edits target this override when set
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
  selectOverride: (id: string | null) => void;
  addOverride: (edgeId: string) => void;
  removeOverride: (edgeId: string, ovId: string) => void;
  updateOverrideRange: (edgeId: string, ovId: string, fromM: number, toM: number) => void;
  moveNodeTo: (id: string, x: number, y: number) => void;
  mergeNodePair: (keep: string, drop: string) => void;
  splitEdgeAt: (edgeId: string, x: number, y: number) => void;
  simplifyAll: (tolM: number) => void;
  cleanNetwork: () => void;
  importOsm: (lat: number, lon: number, radiusM: number) => Promise<void>;
  loadSample: () => Promise<void>;
  scanDualCarriageways: () => void;
  applyDcMerge: (c: DcCandidate) => void;
  setHighlight: (ids: string[]) => void;
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
      selectedEdgeId: null,
      selectedOverrideId: null,
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
      selectEdge: (id) => set({ selectedEdgeId: id, selectedOverrideId: null }),
      selectOverride: (id) => set({ selectedOverrideId: id }),

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
          // With an override selected, the catalog assigns INTO the override.
          if (s.selectedOverrideId && section) {
            const overrides = (e.overrides ?? []).map((o) =>
              o.id === s.selectedOverrideId ? { ...o, section } : o,
            );
            return { edges: { ...s.edges, [edgeId]: { ...e, overrides } } };
          }
          return {
            edges: { ...s.edges, [edgeId]: { ...e, section } },
            reviewList: s.reviewList.filter((r) => r.edgeId !== edgeId),
          };
        }),

      updateSectionComponents: (edgeId, components) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e) return {};
          if (s.selectedOverrideId) {
            const overrides = (e.overrides ?? []).map((o) =>
              o.id === s.selectedOverrideId
                ? { ...o, section: { ...o.section, components } }
                : o,
            );
            return { edges: { ...s.edges, [edgeId]: { ...e, overrides } } };
          }
          if (!e.section) return {};
          return {
            edges: {
              ...s.edges,
              [edgeId]: { ...e, section: { ...e.section, components } },
            },
          };
        }),

      addOverride: (edgeId) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e?.section) return { statusMsg: 'Assign a base section first' };
          const L = polylineLength(e.points);
          if (L < 20) return { statusMsg: 'Street too short for an override' };
          const maxN = Math.max(0, ...(e.overrides ?? []).map((o) => parseInt(o.id.slice(2), 10) || 0));
          const ov = {
            id: `ov${maxN + 1}`,
            fromM: Math.round(L / 3),
            toM: Math.round((2 * L) / 3),
            section: { ...e.section, components: e.section.components.map((c) => ({ ...c })) },
          };
          return {
            edges: { ...s.edges, [edgeId]: { ...e, overrides: [...(e.overrides ?? []), ov] } },
            selectedOverrideId: ov.id,
            statusMsg: `Override ${ov.id} added — pick a section for it from the catalog`,
          };
        }),

      removeOverride: (edgeId, ovId) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e) return {};
          const overrides = (e.overrides ?? []).filter((o) => o.id !== ovId);
          return {
            edges: { ...s.edges, [edgeId]: { ...e, overrides: overrides.length ? overrides : undefined } },
            selectedOverrideId: s.selectedOverrideId === ovId ? null : s.selectedOverrideId,
          };
        }),

      updateOverrideRange: (edgeId, ovId, fromM, toM) =>
        set((s) => {
          const e = s.edges[edgeId];
          if (!e) return {};
          const L = polylineLength(e.points);
          const others = (e.overrides ?? []).filter((o) => o.id !== ovId);
          let lo = 1;
          let hi = L - 1;
          const self = (e.overrides ?? []).find((o) => o.id === ovId);
          if (!self) return {};
          for (const o of others) {
            if (o.toM <= self.fromM + 0.01) lo = Math.max(lo, o.toM + 2);
            if (o.fromM >= self.toM - 0.01) hi = Math.min(hi, o.fromM - 2);
          }
          const f = Math.max(lo, Math.min(fromM, toM - 5));
          const t = Math.min(hi, Math.max(toM, f + 5));
          const overrides = (e.overrides ?? []).map((o) =>
            o.id === ovId ? { ...o, fromM: f, toM: t } : o,
          );
          return { edges: { ...s.edges, [edgeId]: { ...e, overrides } } };
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
          const g = parseOsm(data);
          const cleaned = runStandardPipeline(g);
          set({
            ...cleaned.g,
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
        const g = parseOsm(data);
        const cleaned = runStandardPipeline(g);
        set({
          ...cleaned.g,
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
    }),
    {
      // Only the graph core participates in undo history.
      partialize: (s) => ({
        nodes: s.nodes,
        edges: s.edges,
        nextNodeNum: s.nextNodeNum,
        nextEdgeNum: s.nextEdgeNum,
        selectedEdgeId: s.selectedEdgeId,
      }),
      equality: (a, b) => a.nodes === b.nodes && a.edges === b.edges,
      limit: 100,
    },
  ),
);

export { DEFAULT_IMPORT };
