// Right-edge properties sidebar: whatever object is selected on the canvas
// (mesh face, detailing element) shows its editable properties here — panels
// keep palettes/lifecycle, the sidebar owns per-object state.
import { useCst } from '../store';
import { KIND_COLORS, KIND_LABELS } from '../catalog';
import { ELEMENT_LABELS, ELEMENT_PROPS, propOf } from '../detailing/elements';
import type { ComponentKind } from '../types';

export function PropertiesSidebar() {
  const stage = useCst((s) => s.stage);
  const mesh = useCst((s) => s.mesh);
  const selectedFaceId = useCst((s) => s.selectedFaceId);
  const meshDeleteFace = useCst((s) => s.meshDeleteFace);
  const elements = useCst((s) => s.elements);
  const selectedElementId = useCst((s) => s.selectedElementId);
  const setElementProp = useCst((s) => s.setElementProp);

  const face =
    stage === 'mesh' && mesh ? mesh.faces.find((f) => f.id === selectedFaceId) ?? null : null;
  const selEl = stage === 'detailing' && selectedElementId ? elements[selectedElementId] : null;
  if (!face && !selEl) return null;

  return (
    <aside className="props-side overlay">
      <h3>Object properties</h3>
      {face && (
        <>
          <p className="small">
            <span
              className="chip-swatch"
              style={{ background: KIND_COLORS[face.fn as ComponentKind] ?? '#525e6a' }}
            />
            <strong>{face.id}</strong>
          </p>
          <p className="muted small">
            {face.kind} · {face.nodes.length} nodes ·{' '}
            {face.fn === 'junction'
              ? 'Junction surface'
              : face.fn === 'island'
                ? 'Island / refuge'
                : KIND_LABELS[face.fn as ComponentKind] ?? face.fn}
            {face.edge ? ` · ${face.edge}` : ''}
          </p>
          <p className="muted small">Change the material from the dropdown in the top toolbar.</p>
          <button className="danger" onClick={() => meshDeleteFace(face.id)}>
            Delete (absorb into neighbour)
          </button>
        </>
      )}
      {selEl && (
        <>
          <p className="muted small">
            <strong>#{selEl.id}</strong> · {ELEMENT_LABELS[selEl.kind]}
            {selEl.variant ? ` (${selEl.variant})` : ''} · {selEl.edgeId} @{' '}
            {selEl.stationM.toFixed(1)} m{selEl.placedBy === 'suggest' ? ' · suggested' : ''}
          </p>
          {(ELEMENT_PROPS[selEl.kind] ?? []).length === 0 && (
            <p className="muted small">No editable properties for this type.</p>
          )}
          {(ELEMENT_PROPS[selEl.kind] ?? []).map((f) => (
            <label key={f.key} className="prop-row small">
              <span>{f.label}</span>
              {f.type === 'select' ? (
                <select
                  value={propOf(selEl, f.key, f.default as string)}
                  onChange={(e) => setElementProp(selEl.id, f.key, e.target.value)}
                >
                  {f.options!.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === 'number' ? (
                <input
                  type="number"
                  step={0.1}
                  min={f.min}
                  max={f.max}
                  value={propOf(selEl, f.key, f.default as number)}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) setElementProp(selEl.id, f.key, v);
                  }}
                />
              ) : (
                <input
                  type="checkbox"
                  checked={propOf(selEl, f.key, f.default as boolean)}
                  onChange={(e) => setElementProp(selEl.id, f.key, e.target.checked)}
                />
              )}
            </label>
          ))}
        </>
      )}
    </aside>
  );
}
