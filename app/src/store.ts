import { create } from 'zustand';
import type { Stage, StreetEdge, Tool } from './types';
import { dedupe, toFlat, toPts } from './geometry/polyline';

// One shared store across all stages; stage is a UI mode, not a data boundary (Plan v2 §1.1).

interface CstState {
  stage: Stage;
  tool: Tool;
  edges: StreetEdge[];
  selectedEdgeId: string | null;
  draft: number[]; // in-progress centerline while drawing, flat metres
  nextEdgeNum: number;

  setStage: (stage: Stage) => void;
  setTool: (tool: Tool) => void;
  addDraftPoint: (x: number, y: number) => void;
  finishDraft: () => void;
  cancelDraft: () => void;
  selectEdge: (id: string | null) => void;
  deleteEdge: (id: string) => void;
  assignSection: (edgeId: string, sectionId: string | null) => void;
}

export const useCst = create<CstState>((set) => ({
  stage: 'network',
  tool: 'select',
  edges: [],
  selectedEdgeId: null,
  draft: [],
  nextEdgeNum: 1,

  setStage: (stage) => set({ stage, tool: 'select', draft: [] }),
  setTool: (tool) => set((s) => ({ tool, draft: tool === 'draw' ? s.draft : [] })),

  addDraftPoint: (x, y) => set((s) => ({ draft: [...s.draft, x, y] })),

  finishDraft: () =>
    set((s) => {
      const pts = dedupe(toPts(s.draft));
      if (pts.length < 2) return { draft: [] };
      const edge: StreetEdge = {
        id: `e${s.nextEdgeNum}`,
        points: toFlat(pts),
        sectionId: null,
      };
      return {
        draft: [],
        edges: [...s.edges, edge],
        nextEdgeNum: s.nextEdgeNum + 1,
        selectedEdgeId: edge.id,
      };
    }),

  cancelDraft: () => set({ draft: [] }),

  selectEdge: (id) => set({ selectedEdgeId: id }),

  deleteEdge: (id) =>
    set((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
    })),

  assignSection: (edgeId, sectionId) =>
    set((s) => ({
      edges: s.edges.map((e) => (e.id === edgeId ? { ...e, sectionId } : e)),
    })),
}));
