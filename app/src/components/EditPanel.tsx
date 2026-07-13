import { useCst } from '../store';
import { KIND_COLORS, KIND_LABELS } from '../catalog';
import type { PatchKind } from '../types';

// The materials a patch can be painted in, plus 'cut' (erase to ground) —
// the escape hatch for compound walls and geometry the pipeline can't express.
const PATCH_KINDS: PatchKind[] = [
  'footpath',
  'carriageway',
  'cycle',
  'buffer',
  'median',
  'muz',
  'livability',
  'parking',
  'cut',
];

export function EditPanel() {
  const patches = useCst((s) => s.patches);
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const meshEdits = useCst((s) => s.meshEdits);
  const removeMeshDelta = useCst((s) => s.removeMeshDelta);
  const clearMeshEdits = useCst((s) => s.clearMeshEdits);
  const clearShapeOverrides = useCst((s) => s.clearShapeOverrides);
  const patchKind = useCst((s) => s.patchKind);
  const setPatchKind = useCst((s) => s.setPatchKind);
  const patchDraft = useCst((s) => s.patchDraft);
  const selectedPatchId = useCst((s) => s.selectedPatchId);
  const selectPatch = useCst((s) => s.selectPatch);
  const removePatch = useCst((s) => s.removePatch);
  const focusPatch = (pts: number[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
    useCst.setState({ pendingFit: { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 } });
  };

  const list = Object.values(patches);

  return (
    <div className="panel">
      <h2>Edit shapes</h2>
      <p className="muted small">
        Ultimate control over the final street shapes: draw closed patches to
        add paved area, extend a footpath around a compound wall, or{' '}
        <strong>cut</strong> geometry away. Pick a material, click vertices on
        the canvas, Enter or double-click to close. Drag vertices to refine;
        right-click a vertex removes it, right-click a patch deletes it.
      </p>

      <h3>Mesh node editing</h3>
      <p className="muted small">
        The whole street is one <strong>shared-node mesh</strong>: every point
        where surfaces meet exists exactly once. Drag any node and the
        footpath, cycle track, carriageway, junction and corner it touches all
        reshape together — hovering a node outlines everything it drives.
        Edits are stored by stable node key, so they ride along when the
        street regenerates and drop out if their geometry disappears.
        Right-click a node resets it.
      </p>
      {Object.keys(meshEdits).length > 0 && (
        <>
          <h3 className="row-between">
            Mesh edits ({Object.keys(meshEdits).length})
            <button className="mini" title="reset all mesh edits" onClick={clearMeshEdits}>
              reset all
            </button>
          </h3>
          <ul className="edge-list">
            {Object.entries(meshEdits).map(([key, d]) => (
              <li key={key} className="row-between small">
                <span className="mono">
                  {key} · {Math.hypot(d.dx, d.dy).toFixed(2)} m
                </span>
                <button className="mini" title="reset this node" onClick={() => removeMeshDelta(key)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {Object.keys(vertexOverrides).length > 0 && (
        <>
          <h3>Legacy shape nudges ({Object.keys(vertexOverrides).length})</h3>
          <ul className="edge-list">
            {Object.entries(vertexOverrides).map(([key, ov]) => (
              <li key={key} className="row-between small">
                <span className="mono">
                  {key} · {Object.keys(ov).length} node(s)
                </span>
                <button className="mini" title="reset to generated geometry" onClick={() => clearShapeOverrides(key)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Material</h3>
      <div className="palette">
        {PATCH_KINDS.map((k) => (
          <button
            key={k}
            className={patchKind === k ? 'chip active' : 'chip'}
            onClick={() => setPatchKind(patchKind === k ? null : k)}
          >
            {k === 'cut' ? (
              '✂ Cut'
            ) : (
              <>
                <span
                  className="chip-swatch"
                  style={{ background: KIND_COLORS[k as keyof typeof KIND_COLORS] }}
                />
                {KIND_LABELS[k as keyof typeof KIND_LABELS] ?? k}
              </>
            )}
          </button>
        ))}
      </div>
      {patchDraft.length > 0 && (
        <p className="muted small">{patchDraft.length / 2} vertices — Enter closes, Esc cancels.</p>
      )}

      <h3>Patches ({list.length})</h3>
      <ul className="edge-list tall">
        {list.map((p) => (
          <li key={p.id} className="row-between small">
            <button
              className={p.id === selectedPatchId ? 'active' : ''}
              onClick={() => {
                selectPatch(p.id);
                focusPatch(p.points);
              }}
            >
              <strong>{p.id}</strong> · {p.kind} · {p.points.length / 2} pts
            </button>
            <button className="mini" onClick={() => removePatch(p.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && (
        <p className="muted small">No patches yet — pick a material and click on the canvas.</p>
      )}
    </div>
  );
}
