import { useEffect, useState } from 'react';
import { useCst } from './store';
import { NetworkPanel } from './components/NetworkPanel';
import { SectionsPanel } from './components/SectionsPanel';
import { CanvasStage } from './components/CanvasStage';
import { StripEditor } from './components/StripEditor';
import { GeocodeSearch } from './components/GeocodeSearch';
import { JunctionsPanel } from './components/JunctionsPanel';
import { DetailingPanel } from './components/DetailingPanel';
import { ExportPanel } from './components/ExportPanel';
import { StageRail, ToolRail } from './components/FloatingUI';
import type { Stage, Tool } from './types';

const STAGE_KEYS: Record<string, Stage> = {
  '1': 'network',
  '2': 'sections',
  '3': 'junctions',
  '4': 'detailing',
  '5': 'export',
};

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  d: 'draw',
  x: 'split',
  m: 'marquee',
  l: 'lasso',
};

export default function App() {
  const stage = useCst((s) => s.stage);
  const designOpacity = useCst((s) => s.designOpacity);
  const setDesignOpacity = useCst((s) => s.setDesignOpacity);
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const s = useCst.getState();
      const t = useCst.temporal.getState();
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) t.redo();
        else t.undo();
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        t.redo();
      } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault();
        s.selectAll();
      } else if (e.key === 'Escape') {
        if (s.draft.length > 0) s.cancelDraft();
        else if (s.placeKind) s.setPlaceKind(null);
        else if (s.tool !== 'select') s.setTool('select');
        else if (s.selectedElementId) s.selectElement(null);
        else if (s.selectedJunctionKey) s.selectJunction(null);
        else s.selectEdge(null);
      } else if (e.key === 'Enter' && s.draft.length >= 2) {
        s.finishDraft(0.5);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedElementId) s.removeElement(s.selectedElementId);
        else if (s.selectedEdgeIds.length > 0) s.removeEdges(s.selectedEdgeIds);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (STAGE_KEYS[k]) {
          s.setStage(STAGE_KEYS[k]);
          setPanelOpen(true);
        } else if (TOOL_KEYS[k]) {
          // draw/split only exist where their rail shows them
          if (TOOL_KEYS[k] === 'draw' && s.stage !== 'network') return;
          if (TOOL_KEYS[k] === 'split' && s.stage !== 'network' && s.stage !== 'sections') return;
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
        <GeocodeSearch />
        <div className="header-actions">
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
          <button onClick={() => useCst.temporal.getState().undo()} title="Undo (Ctrl+Z)">
            ↩
          </button>
          <button onClick={() => useCst.temporal.getState().redo()} title="Redo (Ctrl+Shift+Z)">
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
        <ToolRail />
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
