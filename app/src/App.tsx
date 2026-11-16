import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useCst } from './store';

// three.js loads only when the 3D view opens — the plan editor stays lean.
const Scene3D = lazy(() => import('./components/Scene3D'));

/** Global status toast: every store statusMsg surfaces here, auto-dismissing —
 *  feedback no longer depends on which ribbon tab happens to be open. */
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
  ['1 – 7', 'Stages: Network · Street · Junction · Mesh · Detail · Edit · Export'],
  ['V / A', 'Select · Direct selection (move nodes & vertices)'],
  ['M / L', 'Rectangle · Lasso selection'],
  ['D / X / E', 'Draw · Split · Delete street (network stage)'],
  ['F', 'Fit the whole network'],
  ['P', 'Collapse / expand the ribbon'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo · Redo'],
  ['Ctrl+A', 'Select all streets'],
  ['Enter / double-click', 'Finish street, boundary, or patch'],
  ['Esc', 'Cancel drawing → drop tool → clear selection'],
  ['Delete', 'Remove the selected street / element / patch / boundary'],
  ['Shift-click / Ctrl-click', 'Add to · toggle selection'],
  ['Right-click', 'Remove node, vertex, element, or patch'],
  ['?', 'This help'],
];

function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const settings = useCst((s) => s.settings);
  const setSetting = useCst((s) => s.setSetting);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="settings-grid">
          <label>Theme</label>
          <div className="tool-row">
            <button className={settings.theme === 'day' ? 'active' : ''} onClick={() => setSetting('theme', 'day')}>
              ☀ Day
            </button>
            <button className={settings.theme === 'night' ? 'active' : ''} onClick={() => setSetting('theme', 'night')}>
              ☾ Night
            </button>
          </div>
          <label>Traffic</label>
          <div className="tool-row">
            <button className={settings.drive === 'lht' ? 'active' : ''} onClick={() => setSetting('drive', 'lht')}>
              Left-hand drive
            </button>
            <button className={settings.drive === 'rht' ? 'active' : ''} onClick={() => setSetting('drive', 'rht')}>
              Right-hand drive
            </button>
          </div>
          <label>Junctions</label>
          <div>
            <div className="tool-row">
              <button
                className={settings.junctionCorners === 'common' ? 'active' : ''}
                title="Only elements present on BOTH streets sweep the corner at their own width — fillet, no transition (default)"
                onClick={() => setSetting('junctionCorners', 'common')}
              >
                Common merge
              </button>
              <button
                className={settings.junctionCorners === 'blend' ? 'active' : ''}
                title="Unmatched elements transition in and out around the corner (wedges/aprons)"
                onClick={() => setSetting('junctionCorners', 'blend')}
              >
                Transition
              </button>
              <button
                className={settings.junctionCorners === 'off' ? 'active' : ''}
                title="Every band simply ends at the junction mouth"
                onClick={() => setSetting('junctionCorners', 'off')}
              >
                Off
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>
              Corner behaviour where streets meet. Mid-street split transitions
              are always on.
            </p>
          </div>
          <label>Performance</label>
          <label className="check">
            <input type="checkbox" checked={settings.lod} onChange={(e) => setSetting('lod', e.target.checked)} />
            Hide sub-pixel detail (markings, furniture) when zoomed out
          </label>
        </div>
        <button className="mini" onClick={onClose}>
          Close (Esc)
        </button>
      </div>
    </div>
  );
}

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
import { CanvasStage } from './components/CanvasStage';
import { StripEditor } from './components/StripEditor';
import { Ribbon } from './components/Ribbon';
import type { Stage, Tool } from './types';

const STAGE_KEYS: Record<string, Stage> = {
  '1': 'network',
  '2': 'sections',
  '3': 'junctions',
  '4': 'mesh',
  '5': 'detailing',
  '6': 'edit',
  '7': 'export',
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
  const [ribbonOpen, setRibbonOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view3d, setView3d] = useState(false);
  const overlayRef = useRef({ open: false });
  overlayRef.current = { open: helpOpen || view3d || settingsOpen };
  const theme = useCst((s) => s.settings.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const s = useCst.getState();
      const k = e.key.toLowerCase();
      // Overlays swallow keys: Esc closes, ? toggles help, rest pass nothing.
      if (overlayRef.current.open) {
        if (e.key === 'Escape' || e.key === '?') {
          setHelpOpen(false);
          setView3d(false);
          setSettingsOpen(false);
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
      } else if (e.key === 'Backspace' && s.draft.length > 0) {
        // step back one vertex without cancelling the drawing
        s.popDraftVert();
      } else if (e.key === 'Backspace' && s.boundaryDraft.length > 0) {
        useCst.setState({ boundaryDraft: s.boundaryDraft.slice(0, -2) });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedPatchId) s.removePatch(s.selectedPatchId);
        else if (s.selectedElementId) s.removeElement(s.selectedElementId);
        else if (s.selectedBoundaryId) s.removeBoundary(s.selectedBoundaryId);
        else if (s.selectedEdgeIds.length > 0) s.removeEdges(s.selectedEdgeIds);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (STAGE_KEYS[k]) {
          s.setStage(STAGE_KEYS[k]);
          setRibbonOpen(true);
        } else if (TOOL_KEYS[k]) {
          // direct is network-only (nodes & vertices render there); draw/split/
          // erase also work in the street stage (mid-street section changes)
          if (TOOL_KEYS[k] === 'direct' && s.stage !== 'network') return;
          if (['draw', 'split', 'erase'].includes(TOOL_KEYS[k]) && !['network', 'sections'].includes(s.stage)) return;
          s.setTool(TOOL_KEYS[k]);
        } else if (k === 'f') {
          s.fitAll();
        } else if (k === 'p') {
          setRibbonOpen((o) => !o);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Ribbon
        open={ribbonOpen}
        onToggle={setRibbonOpen}
        onOpen3d={() => setView3d(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
      />
      <main>
        <div className="canvas-col">
          <CanvasStage />
          {stage === 'sections' && <StripEditor />}
        </div>
        <Toast />
      </main>
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}
      {view3d && (
        <Suspense fallback={<div className="scene3d loading">Loading 3D…</div>}>
          <Scene3D onClose={() => setView3d(false)} />
        </Suspense>
      )}
    </div>
  );
}
