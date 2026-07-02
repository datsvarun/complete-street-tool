import { useCst } from '../store';
import { CATALOG_BY_ROW, getSection, KIND_COLORS, KIND_LABELS } from '../catalog';
import { polylineLength } from '../geometry/polyline';
import type { ComponentKind } from '../types';

export function SectionsPanel() {
  const { edges, selectedEdgeId } = useCst();
  const assignSection = useCst((s) => s.assignSection);
  const selected = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const currentSection = getSection(selected?.sectionId ?? null);

  const usedKinds = new Set<ComponentKind>();
  for (const e of edges) {
    const s = getSection(e.sectionId);
    s?.components.forEach((c) => usedKinds.add(c.kind));
  }

  return (
    <div className="panel">
      <h2>Sections</h2>
      {selected ? (
        <p>
          <strong>{selected.id}</strong> · {polylineLength(selected.points).toFixed(0)} m
          {currentSection && (
            <span className="muted"> · {currentSection.name}</span>
          )}
        </p>
      ) : (
        <p className="muted">Click a street on the canvas to assign a section.</p>
      )}
      {selected && currentSection && (
        <button className="danger" onClick={() => assignSection(selected.id, null)}>
          Remove section
        </button>
      )}

      <h3>IRC SP:118-2018 catalog</h3>
      <div className="catalog">
        {CATALOG_BY_ROW.map((group) => (
          <details key={group.rowWidthM} open={group.rowWidthM === 12}>
            <summary>{group.rowWidthM} m ROW</summary>
            {group.sections.map((s) => (
              <button
                key={s.id}
                className={currentSection?.id === s.id ? 'catalog-item active' : 'catalog-item'}
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
    </div>
  );
}
