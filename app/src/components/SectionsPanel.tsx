import { useCst } from '../store';
import { CATALOG_BY_ROW, getSection, KIND_COLORS, KIND_LABELS } from '../catalog';
import { polylineLength } from '../geometry/polyline';
import type { ComponentKind } from '../types';

export function SectionsPanel() {
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const reviewList = useCst((s) => s.reviewList);
  const statusMsg = useCst((s) => s.statusMsg);
  const assignSection = useCst((s) => s.assignSection);
  const selectEdge = useCst((s) => s.selectEdge);
  const dismissReview = useCst((s) => s.dismissReview);
  const autoAssign = useCst((s) => s.autoAssign);
  const selected = selectedEdgeId ? (edges[selectedEdgeId] ?? null) : null;
  const currentCatalog = getSection(selected?.section?.catalogId ?? null);

  const usedKinds = new Set<ComponentKind>();
  for (const e of Object.values(edges)) {
    e.section?.components.forEach((c) => usedKinds.add(c.kind));
  }

  return (
    <div className="panel">
      <h2>Sections</h2>
      {selected ? (
        <p>
          <strong>{selected.id}</strong> · {polylineLength(selected.points).toFixed(0)} m
          {selected.name && <span className="muted"> · {selected.name}</span>}
          {selected.section && (
            <span className="muted">
              {' '}
              · {currentCatalog ? currentCatalog.name : 'custom section'}
            </span>
          )}
        </p>
      ) : (
        <p className="muted">Click a street on the canvas, or an item in the review list.</p>
      )}
      {selected?.section && (
        <button className="danger" onClick={() => assignSection(selected.id, null)}>
          Remove section
        </button>
      )}

      <h3>Auto-assignment</h3>
      <button onClick={() => autoAssign()}>Assign from highway class</button>
      {reviewList.length > 0 && (
        <>
          <p className="muted small">Review ({reviewList.length}):</p>
          <ul className="review-list">
            {reviewList.map((r) => (
              <li key={r.edgeId} className={r.edgeId === selectedEdgeId ? 'active' : ''}>
                <button onClick={() => selectEdge(r.edgeId)}>
                  <strong>{r.edgeId}</strong>
                  <span className="muted small"> {r.reason}</span>
                </button>
                <button className="dismiss" title="Dismiss" onClick={() => dismissReview(r.edgeId)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>IRC SP:118-2018 catalog</h3>
      <div className="catalog">
        {CATALOG_BY_ROW.map((group) => (
          <details key={group.rowWidthM} open={group.rowWidthM === 24}>
            <summary>{group.rowWidthM} m ROW</summary>
            {group.sections.map((s) => (
              <button
                key={s.id}
                className={currentCatalog?.id === s.id ? 'catalog-item active' : 'catalog-item'}
                disabled={!selected}
                title={selected ? undefined : 'Select a street first'}
                onClick={() => selected && assignSection(selected.id, s.id)}
              >
                <span>{s.name}</span>
                <span className="muted">Σ {s.totalWidthM.toFixed(2)} m</span>
              </button>
            ))}
          </details>
        ))}
      </div>

      {usedKinds.size > 0 && (
        <>
          <h3>Legend</h3>
          <ul className="legend">
            {[...usedKinds].map((k) => (
              <li key={k}>
                <span className="chip" style={{ background: KIND_COLORS[k] }} />
                {KIND_LABELS[k]}
              </li>
            ))}
          </ul>
        </>
      )}
      {statusMsg && <p className="status small">{statusMsg}</p>}
    </div>
  );
}
