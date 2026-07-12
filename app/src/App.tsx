import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useCst } from './store';
import { downloadDocument } from './persistence';

// three.js loads only when the 3D view opens — the plan editor stays lean.
const Scene3D = lazy(() => import('./components/Scene3D'));

/** Global status toast: every store statusMsg surfaces here, auto-dismissing —
 *  feedback no longer depends on which panel happens to be open. */
function Toast() {
  const statusMsg = useCst((s) => s.statusMsg);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!statusMsg) {
      setShown(false);
      return;
    }
    setShown(true);
    const t = window.setTimeout(() => setShown(false), 3500);
    return () => window.clearTimeout(t);
  }, [statusMsg]);
  if (!shown || !statusMsg) return null;
  return (
    <div className="toast" role="status">
      {statusMsg}
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['1 – 6', 'Stages: Network · Street · Junction · Detail · Edit · Export'],
  ['V / A', 'Select · Direct selection (move nodes & vertices)'],
  ['M / L', 'Rectangle · Lasso selection'],
  ['D / X / E', 'Draw · Split · Delete street (network stage)'],
  ['F', 'Fit the whole network'],
  ['P', 'Show / hide the stage panel'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo · Redo'],
  ['Ctrl+A', 'Select all streets'],
  ['Enter / double-click', 'Finish street, boundary, or patch'],
  ['Esc', 'Cancel drawing → drop tool → clear selection'],
  ['Delete', 'Remove the selected street / element / patch / boundary'],
  ['Shift-click / Ctrl-click', 'Add to · toggle selection'],
  ['Right-click', 'Remove node, vertex, element, or patch'],
  ['?', 'This help'],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, desc]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="mini" onClick={onClose}>
          Close (Esc)
        </button>
      </div>
    </div>
  );
}
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [view3d, setView3d] = useState(false);
  const overlayRef = useRef({ helpOpen: false, view3d: false });
  overlayRef.current = { helpOpen, view3d };
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
      // Overlays swallow keys: Esc closes, ? toggles help, rest pass nothing.
      if (overlayRef.current.helpOpen || overlayRef.current.view3d) {
        if (e.key === 'Escape' || e.key === '?') {
          setHelpOpen(false);
          setView3d(false);
        }
        return;
      }
      if (e.key === '?') {
        setHelpOpen(true);
        return;
      }
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
        else if (s.selectedShapeKey) s.selectShape(null);
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
          <button onClick={() => setView3d(true)} title="Preview the design in 3D">
            3D
          </button>
          <button onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">
            ?
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
      <Toast />
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {view3d && (
        <Suspense fallback={<div className="scene3d loading">Loading 3D…</div>}>
          <Scene3D onClose={() => setView3d(false)} />
        </Suspense>
      )}
    </div>
  );
}
