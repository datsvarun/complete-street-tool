import { useCst } from '../store';
import { CATALOG_BY_ROW, getSection, KIND_COLORS, KIND_LABELS } from '../catalog';
import { polylineLength } from '../geometry/polyline';
import type { ComponentKind } from '../types';

export function SectionsPanel() {
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const reviewList = useCst((s) => s.reviewList);
  const assignSectionToSelected = useCst((s) => s.assignSectionToSelected);
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
        <button className="danger" onClick={() => assignSectionToSelected(null)}>
          Remove section
        </button>
      )}

      <p className="muted small">
        For a mid-street section change, use the Split tool (✂ / X) from the
        toolbar — the shared node becomes a smooth transition automatically.
      </p>

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

      <h3>Road sections</h3>
      <p className="muted small">
        Sorted by right-of-way. “Standard” = rule of thirds (⅓ to sidewalks,
        0.6 m median from 12 m up); “IRC” = SP:118-2018 configurations.
      </p>
      <div className="catalog">
        {CATALOG_BY_ROW.map((group) => (
          <details key={group.rowWidthM} open>
            <summary>{group.rowWidthM} m ROW</summary>
            {group.sections.map((s) => (
              <button
                key={s.id}
                className={currentCatalog?.id === s.id ? 'catalog-item active' : 'catalog-item'}
                disabled={!selected}
                title={selected ? s.name : 'Select a street first'}
                onClick={() => selected && assignSectionToSelected(s.id)}
              >
                <span className="catalog-title">
                  {s.label}
                  <span className="muted small"> Σ {s.totalWidthM.toFixed(1)} m</span>
                </span>
                <span className="mini-section">
                  {s.components.map((c, i) => (
                    <span
                      key={i}
                      style={{ flexGrow: c.widthM, background: KIND_COLORS[c.kind] }}
                      title={`${c.element} ${c.widthM} m`}
                    />
                  ))}
                </span>
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
    </div>
  );
}
