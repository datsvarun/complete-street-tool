import { useEffect } from 'react';
import { useCst } from './store';
import { StageTabs } from './components/StageTabs';
import { NetworkPanel } from './components/NetworkPanel';
import { SectionsPanel } from './components/SectionsPanel';
import { CanvasStage } from './components/CanvasStage';

export default function App() {
  const stage = useCst((s) => s.stage);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useCst.getState();
      if (e.key === 'Escape') {
        if (s.draft.length > 0) s.cancelDraft();
        else if (s.tool === 'draw') s.setTool('select');
        else s.selectEdge(null);
      } else if (e.key === 'Enter' && s.draft.length >= 4) {
        s.finishDraft();
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        s.selectedEdgeId
      ) {
        s.deleteEdge(s.selectedEdgeId);
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
      </header>
      <main>
        <aside>{stage === 'sections' ? <SectionsPanel /> : <NetworkPanel />}</aside>
        <CanvasStage />
      </main>
    </div>
  );
}
