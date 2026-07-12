import { useEffect, useRef, useState } from 'react';
import { useCst } from './store';
import { downloadDocument } from './persistence';
import { NetworkPanel } from './components/NetworkPanel';
import { SectionsPanel } from './components/SectionsPanel';
import { CanvasStage } from './components/CanvasStage';
import { StripEditor } from './components/StripEditor';
import { GeocodeSearch } from './components/GeocodeSearch';
import { JunctionsPanel } from './components/JunctionsPanel';
import { DetailingPanel } from './components/DetailingPanel';
import { ExportPanel } from './components/ExportPanel';
import { EditPanel } from './components/EditPanel';
import { StageRail, TopToolbar } from './components/FloatingUI';
import type { Stage, Tool } from './types';

const STAGE_KEYS: Record<string, Stage> = {
  '1': 'network',
  '2': 'sections',
  '3': 'junctions',
  '4': 'detailing',
  '5': 'edit',
  '6': 'export',
};

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  a: 'direct',
  d: 'draw',
  x: 'split',
  e: 'erase',
  m: 'marquee',
  l: 'lasso',
};

export default function App() {
  const stage = useCst((s) => s.stage);
  const designOpacity = useCst((s) => s.designOpacity);
  const setDesignOpacity = useCst((s) => s.setDesignOpacity);
  const [panelOpen, setPanelOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const openFile = async (file: File) => {
    try {
      useCst.getState().loadDocument(JSON.parse(await file.text()), file.name);
    } catch {
      useCst.setState({ statusMsg: `Open failed: ${file.name} is not valid JSON` });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const s = useCst.getState();
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        s.redo();
      } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault();
        s.selectAll();
      } else if (e.key === 'Escape') {
        if (s.boxDraw) s.setBoxDraw(null);
        else if (s.boundaryDraw) s.cancelBoundary();
        else if (s.draft.length > 0) s.cancelDraft();
        else if (s.patchDraft.length > 0) s.cancelPatch();
        else if (s.patchKind) s.setPatchKind(null);
        else if (s.placeKind) s.setPlaceKind(null);
        else if (s.tool !== 'select') s.setTool('select');
        else if (s.selectedElementId) s.selectElement(null);
        else if (s.selectedJunctionKey) s.selectJunction(null);
        else if (s.selectedBoundaryId) s.selectBoundary(null);
        else s.selectEdge(null);
      } else if (e.key === 'Enter' && s.boundaryDraw && s.boundaryDraft.length >= 4) {
        s.finishBoundary();
      } else if (e.key === 'Enter' && s.draft.length >= 2) {
        s.finishDraft(0.5);
      } else if (e.key === 'Enter' && s.patchDraft.length >= 6) {
        s.finishPatch();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedPatchId) s.removePatch(s.selectedPatchId);
        else if (s.selectedElementId) s.removeElement(s.selectedElementId);
        else if (s.selectedBoundaryId) s.removeBoundary(s.selectedBoundaryId);
        else if (s.selectedEdgeIds.length > 0) s.removeEdges(s.selectedEdgeIds);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (STAGE_KEYS[k]) {
          s.setStage(STAGE_KEYS[k]);
          setPanelOpen(true);
        } else if (TOOL_KEYS[k]) {
          // direct/draw/split/erase are network-only (nodes & vertices live there)
          if (['direct', 'draw', 'split', 'erase'].includes(TOOL_KEYS[k]) && s.stage !== 'network') return;
          s.setTool(TOOL_KEYS[k]);
        } else if (k === 'f') {
          s.fitAll();
        } else if (k === 'p') {
          setPanelOpen((o) => !o);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header>
        <span className="brand">
          CST <span className="muted">· IRC Street Designer</span>
        </span>
        <TopToolbar />
        <GeocodeSearch />
        <div className="header-actions">
          <button onClick={() => downloadDocument(useCst.getState())} title="Save the design as a .cst.json file">
            Save
          </button>
          <button onClick={() => fileRef.current?.click()} title="Open a saved .cst.json design">
            Open
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => {
              if (window.confirm('Start a new design? The current design will be discarded.')) {
                useCst.getState().clearAll();
              }
            }}
            title="Clear everything and start a new design"
          >
            New
          </button>
          <label className="opacity-slider" title="Design layer transparency (see the basemap through the plan)">
            <span className="muted small">design</span>
            <input
              type="range"
              min="15"
              max="100"
              value={Math.round(designOpacity * 100)}
              onChange={(e) => setDesignOpacity(parseInt(e.target.value, 10) / 100)}
            />
          </label>
          <button onClick={() => useCst.getState().undo()} title="Undo (Ctrl+Z)">
            ↩
          </button>
          <button onClick={() => useCst.getState().redo()} title="Redo (Ctrl+Shift+Z)">
            ↪
          </button>
        </div>
      </header>
      <main>
        <div className="canvas-col">
          <CanvasStage />
          {stage === 'sections' && <StripEditor />}
        </div>
        <StageRail panelOpen={panelOpen} onToggle={setPanelOpen} />
        {panelOpen && (
          <div className="floating-panel overlay">
            <button className="panel-close" title="Close panel (P)" onClick={() => setPanelOpen(false)}>
              ×
            </button>
            {stage === 'sections' ? (
              <SectionsPanel />
            ) : stage === 'junctions' ? (
              <JunctionsPanel />
            ) : stage === 'detailing' ? (
              <DetailingPanel />
            ) : stage === 'edit' ? (
              <EditPanel />
            ) : stage === 'export' ? (
              <ExportPanel />
            ) : (
              <NetworkPanel />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
