import { useEffect } from 'react';
import { useCst } from './store';
import { StageTabs } from './components/StageTabs';
import { NetworkPanel } from './components/NetworkPanel';
import { SectionsPanel } from './components/SectionsPanel';
import { CanvasStage } from './components/CanvasStage';
import { StripEditor } from './components/StripEditor';
import { GeocodeSearch } from './components/GeocodeSearch';
import { JunctionsPanel } from './components/JunctionsPanel';

export default function App() {
  const stage = useCst((s) => s.stage);
  const designOpacity = useCst((s) => s.designOpacity);
  const setDesignOpacity = useCst((s) => s.setDesignOpacity);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const s = useCst.getState();
      const t = useCst.temporal.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) t.redo();
        else t.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        t.redo();
      } else if (e.key === 'Escape') {
        if (s.draft.length > 0) s.cancelDraft();
        else if (s.tool !== 'select') s.setTool('select');
        else s.selectEdge(null);
      } else if (e.key === 'Enter' && s.draft.length >= 2) {
        s.finishDraft(0.5);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedEdgeIds.length > 0) {
        s.removeEdges(s.selectedEdgeIds);
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
        <StageTabs />
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
        <aside>
          {stage === 'sections' ? (
            <SectionsPanel />
          ) : stage === 'junctions' ? (
            <JunctionsPanel />
          ) : (
            <NetworkPanel />
          )}
        </aside>
        <div className="canvas-col">
          <CanvasStage />
          {stage === 'sections' && <StripEditor />}
        </div>
      </main>
    </div>
  );
}
