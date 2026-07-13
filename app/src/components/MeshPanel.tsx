import { useCst } from '../store';
import { KIND_COLORS, KIND_LABELS } from '../catalog';
import type { MeshFn } from '../mesh/engine';
import type { ComponentKind } from '../types';

const MATERIALS: MeshFn[] = [
  'carriageway', 'footpath', 'cycle', 'parking', 'median', 'muz', 'buffer',
  'tree', 'livability', 'busstop', 'service', 'island', 'junction',
];

const TOOLS: Array<{ id: ReturnType<typeof useCst.getState>['meshTool']; label: string; hint: string }> = [
  { id: 'select', label: '➤ Select', hint: 'Click a face to select it · drag nodes to reshape (shared nodes move every abutting shape)' },
  { id: 'addnode', label: '+ Node', hint: 'Click on any shape edge to add a node there (added to every shape sharing that edge)' },
  { id: 'split', label: '✂ Split', hint: 'Click two nodes of one face — it splits along the chord' },
  { id: 'cut', label: '⊟ Cut across', hint: 'Click a street strip — every band splits at that station (bus bays, parking bays)' },
  { id: 'merge', label: '⊞ Merge', hint: 'Click two abutting faces to merge them' },
  { id: 'fillet', label: '◠ Fillet', hint: 'Click a corner node — replaced by an arc in every shape using it' },
  { id: 'delete', label: '⌫ Delete', hint: 'Click a face — absorbed into its drivable neighbour' },
];

export function MeshPanel() {
  const mesh = useCst((s) => s.mesh);
  const meshTool = useCst((s) => s.meshTool);
  const setMeshTool = useCst((s) => s.setMeshTool);
  const selectedFaceId = useCst((s) => s.selectedFaceId);
  const meshRetypeSelected = useCst((s) => s.meshRetypeSelected);
  const meshDeleteFace = useCst((s) => s.meshDeleteFace);
  const filletR = useCst((s) => s.filletR);
  const setFilletR = useCst((s) => s.setFilletR);
  const generateMesh = useCst((s) => s.generateMesh);
  const resetMesh = useCst((s) => s.resetMesh);

  const face = mesh?.faces.find((f) => f.id === selectedFaceId) ?? null;

  return (
    <div className="panel">
      <h2>Mesh editing</h2>
      <p className="muted small">
        The whole design frozen into one shared-node mesh: every point exists
        once, every shape holds one function, abutting shapes share nodes —
        dragging the footpath/carriageway node reshapes both. Build bus bays,
        turn lanes, islands, parking bays, custom junctions here.
      </p>
      {!mesh ? (
        <button onClick={() => generateMesh()}>Generate mesh</button>
      ) : (
        <>
          <p className="muted small">
            {Object.keys(mesh.nodes).length} nodes · {mesh.faces.length} faces ·{' '}
            {mesh.editLog.length} edit(s)
          </p>

          <h3>Tools</h3>
          <div className="palette">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={meshTool === t.id ? 'chip active' : 'chip'}
                title={t.hint}
                onClick={() => setMeshTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {meshTool === 'fillet' && (
            <label className="prop-row small">
              <span>Fillet radius (m)</span>
              <input
                type="number"
                step={0.5}
                min={0.5}
                max={20}
                value={filletR}
                onChange={(e) => setFilletR(parseFloat(e.target.value) || 3)}
              />
            </label>
          )}
          <p className="muted small">{TOOLS.find((t) => t.id === meshTool)?.hint}</p>

          <h3>Selected shape</h3>
          {face ? (
            <>
              <p className="small">
                <strong>{face.id}</strong> · {face.kind} · {face.nodes.length} nodes
              </p>
              <label className="prop-row small">
                <span>Material</span>
                <select value={face.fn} onChange={(e) => meshRetypeSelected(e.target.value as MeshFn)}>
                  {MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {m === 'junction' ? 'Junction surface' : m === 'island' ? 'Island / refuge' : KIND_LABELS[m as ComponentKind] ?? m}
                    </option>
                  ))}
                </select>
              </label>
              <span
                className="chip-swatch"
                style={{ background: KIND_COLORS[face.fn as ComponentKind] ?? '#525e6a' }}
              />
              <button className="danger" onClick={() => meshDeleteFace(face.id)}>
                Delete (absorb into neighbour)
              </button>
            </>
          ) : (
            <p className="muted small">Click a shape on the canvas.</p>
          )}

          <h3>Mesh lifecycle</h3>
          <p className="muted small">
            Changing streets/sections resets the mesh (you'll be asked when it
            has manual edits). Undo (Ctrl+Z) covers every mesh operation.
          </p>
          <div className="tool-row">
            <button
              onClick={() => {
                if (
                  mesh.editLog.length === 0 ||
                  window.confirm(`Regenerate and discard ${mesh.editLog.length} manual edit(s)?`)
                ) {
                  generateMesh();
                }
              }}
            >
              Regenerate
            </button>
            <button className="danger" onClick={() => resetMesh()}>
              Discard mesh
            </button>
          </div>
        </>
      )}
    </div>
  );
}
