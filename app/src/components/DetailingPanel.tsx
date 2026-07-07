import { useMemo } from 'react';
import { useCst } from '../store';
import type { ElementKind } from '../types';
import { ELEMENT_LABELS } from '../detailing/elements';

// Palette groups mirror the user's brief: furniture / plantation, markings,
// crossings & entrances. Turn arrows carry a direction variant.
const GROUPS: Array<{ title: string; items: Array<{ kind: ElementKind; variant?: string; label?: string }> }> = [
  {
    title: 'Furniture & plantation',
    items: [
      { kind: 'tree' },
      { kind: 'streetlight' },
      { kind: 'dustbin' },
      { kind: 'bench' },
      { kind: 'bollard' },
      { kind: 'busstop' },
    ],
  },
  {
    title: 'Carriageway markings',
    items: [
      { kind: 'turnarrow', variant: 'through', label: 'Arrow ↑' },
      { kind: 'turnarrow', variant: 'left', label: 'Arrow ↰' },
      { kind: 'turnarrow', variant: 'right', label: 'Arrow ↱' },
    ],
  },
  {
    title: 'Crossings & entrances',
    items: [
      { kind: 'zebra' },
      { kind: 'raisedcrossing' },
      { kind: 'driveway' },
    ],
  },
];

const SUGGESTABLE: ElementKind[] = ['tree', 'streetlight', 'dustbin'];

export function DetailingPanel() {
  const placeKind = useCst((s) => s.placeKind);
  const placeVariant = useCst((s) => s.placeVariant);
  const setPlaceKind = useCst((s) => s.setPlaceKind);
  const suggest = useCst((s) => s.suggest);
  const clearSuggestions = useCst((s) => s.clearSuggestions);
  const elements = useCst((s) => s.elements);
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const selectEdge = useCst((s) => s.selectEdge);
  const setEdgeLanes = useCst((s) => s.setEdgeLanes);

  const anySection = Object.values(edges).some((e) => e.section);
  const counts = useMemo(() => {
    const c: Partial<Record<ElementKind, number>> = {};
    for (const el of Object.values(elements)) c[el.kind] = (c[el.kind] ?? 0) + 1;
    return c;
  }, [elements]);
  const suggestedCount = Object.values(elements).filter((e) => e.placedBy === 'suggest').length;
  const selectedEdge = selectedEdgeId ? edges[selectedEdgeId] : null;

  const active = (kind: ElementKind, variant?: string) =>
    placeKind === kind && (placeVariant ?? undefined) === (variant ?? undefined);

  return (
    <div className="panel">
      <h2>Detailing</h2>
      <p className="muted small">
        Place furniture, markings and crossings. Every object rides the road
        alignment and stays inside its band — drag along or across, right-click
        to remove. Pick a tool, then click a street.
      </p>
      {!anySection && (
        <p className="muted small">⚠ Assign sections in Stage 2 first — elements anchor to components.</p>
      )}

      {GROUPS.map((g) => (
        <div key={g.title}>
          <h3>{g.title}</h3>
          <div className="palette">
            {g.items.map((it) => (
              <button
                key={`${it.kind}-${it.variant ?? ''}`}
                className={active(it.kind, it.variant) ? 'chip active' : 'chip'}
                onClick={() =>
                  active(it.kind, it.variant)
                    ? setPlaceKind(null)
                    : setPlaceKind(it.kind, it.variant ?? null)
                }
              >
                {it.label ?? ELEMENT_LABELS[it.kind]}
                {counts[it.kind] ? <span className="muted small"> {counts[it.kind]}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ))}

      <h3>Auto-suggest</h3>
      <div className="palette">
        {SUGGESTABLE.map((k) => (
          <button key={k} className="chip" onClick={() => suggest(k)}>
            + {ELEMENT_LABELS[k]}s
          </button>
        ))}
      </div>
      {suggestedCount > 0 && (
        <button className="mini" onClick={clearSuggestions}>
          Clear {suggestedCount} suggestion(s)
        </button>
      )}

      <h3>Lane markings</h3>
      {selectedEdge ? (
        <label className="small">
          {selectedEdge.name || selectedEdgeId} · lanes per carriageway{' '}
          <select
            value={selectedEdge.lanes ?? 0}
            onChange={(e) => setEdgeLanes(selectedEdgeId!, parseInt(e.target.value, 10))}
          >
            <option value={0}>auto / none</option>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted small">Click a street to set its lane count (dashed lane lines).</p>
      )}
      <ul className="edge-list">
        {Object.values(edges)
          .filter((e) => e.section)
          .map((e) => (
            <li key={e.id}>
              <button
                className={e.id === selectedEdgeId ? 'active' : ''}
                onClick={() => selectEdge(e.id)}
              >
                <strong>{e.id}</strong>
                <span className="muted small"> {e.name || ''}{e.lanes ? ` · ${e.lanes} lanes` : ''}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
