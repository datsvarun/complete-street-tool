import { useEffect, useState } from 'react';
import { useCst } from '../store';
import { getSection, KIND_COLORS } from '../catalog';
import {
  COMPONENT_DEFAULTS,
  COMPONENT_MINS,
  normalizeWidth,
  RES_CLICK,
  RES_TYPING,
} from '../sections/rules';
import type { SectionComponent } from '../types';

// Streetmix-style cross-section strip (Case_Study §2): blocks proportional to
// width, click to select, resolution-per-interaction width editing, warnings
// as flags (never blockers).

const DARK_TEXT_KINDS = new Set(['footpath', 'muz', 'mfz', 'busstop', 'parking', 'livability', 'other', 'buffer']);

function belowMin(c: SectionComponent): { minM: number; source: string } | null {
  const rule = COMPONENT_MINS[c.kind];
  return rule && c.widthM < rule.minM - 1e-9 ? rule : null;
}

export function StripEditor() {
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const updateSectionComponents = useCst((s) => s.updateSectionComponents);
  const edge = selectedEdgeId ? edges[selectedEdgeId] : null;
  const section = edge?.section ?? null;

  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [widthText, setWidthText] = useState('');
  const [addKind, setAddKind] = useState(COMPONENT_DEFAULTS[0].element);

  useEffect(() => {
    setSelIdx(null);
  }, [selectedEdgeId]);

  useEffect(() => {
    if (section && selIdx !== null && section.components[selIdx]) {
      setWidthText(section.components[selIdx].widthM.toFixed(2));
    }
  }, [section, selIdx]);

  if (!edge || !section) {
    return (
      <div className="strip-editor empty">
        <span className="muted">
          {edge
            ? 'No section on this street yet — pick one from the catalog.'
            : 'Select a street to edit its cross-section.'}
        </span>
      </div>
    );
  }

  const comps = section.components;
  const total = comps.reduce((s, c) => s + c.widthM, 0);
  const catalog = getSection(section.catalogId);
  const sel = selIdx !== null ? comps[selIdx] : null;

  const update = (next: SectionComponent[]) => updateSectionComponents(edge.id, next);

  const setWidth = (idx: number, w: number, res: number) => {
    const next = comps.map((c, i) => (i === idx ? { ...c, widthM: normalizeWidth(w, res) } : c));
    update(next);
  };

  const nudge = (delta: number) => {
    if (selIdx === null || !sel) return;
    setWidth(selIdx, sel.widthM + delta, RES_CLICK);
  };

  const commitTyped = () => {
    if (selIdx === null) return;
    const w = parseFloat(widthText);
    if (Number.isFinite(w)) setWidth(selIdx, w, RES_TYPING);
  };

  const move = (dir: -1 | 1) => {
    if (selIdx === null) return;
    const j = selIdx + dir;
    if (j < 0 || j >= comps.length) return;
    const next = comps.slice();
    [next[selIdx], next[j]] = [next[j], next[selIdx]];
    update(next);
    setSelIdx(j);
  };

  const remove = () => {
    if (selIdx === null) return;
    update(comps.filter((_, i) => i !== selIdx));
    setSelIdx(null);
  };

  const add = () => {
    const def = COMPONENT_DEFAULTS.find((d) => d.element === addKind)!;
    const next = comps.slice();
    const at = selIdx !== null ? selIdx + 1 : comps.length;
    next.splice(at, 0, { element: def.element, widthM: def.widthM, kind: def.kind });
    update(next);
    setSelIdx(at);
  };

  return (
    <div className="strip-editor">
      <div className="strip-head">
        <span>
          <strong>{edge.id}</strong>
          {edge.name && <span className="muted"> · {edge.name}</span>}
          <span className="muted">
            {' '}
            · Σ {total.toFixed(2)} m
            {catalog && ` · based on “${catalog.name}” (${catalog.rowWidthM} m ROW)`}
          </span>
        </span>
        <span className="strip-actions">
          {sel && (
            <>
              <button onClick={() => nudge(-RES_CLICK)}>−0.1</button>
              <input
                className="w-input"
                value={widthText}
                onChange={(e) => setWidthText(e.target.value)}
                onBlur={commitTyped}
                onKeyDown={(e) => e.key === 'Enter' && commitTyped()}
              />
              <button onClick={() => nudge(RES_CLICK)}>+0.1</button>
              <button onClick={() => move(-1)} title="Move left">◀</button>
              <button onClick={() => move(1)} title="Move right">▶</button>
              <button className="danger" onClick={remove}>Remove</button>
            </>
          )}
          <select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
            {COMPONENT_DEFAULTS.map((d) => (
              <option key={d.element} value={d.element}>
                {d.element}
              </option>
            ))}
          </select>
          <button onClick={add}>Add</button>
        </span>
      </div>
      <div className="strip-row">
        {comps.map((c, i) => {
          const warn = belowMin(c);
          return (
            <button
              key={i}
              className={`strip-block${i === selIdx ? ' selected' : ''}${warn ? ' warn' : ''}`}
              style={{
                flexGrow: c.widthM,
                background: KIND_COLORS[c.kind],
                color: DARK_TEXT_KINDS.has(c.kind) ? '#242c36' : '#f2f5f8',
              }}
              title={
                warn
                  ? `${c.element}: ${c.widthM.toFixed(2)} m is below the ${warn.minM} m minimum — ${warn.source}`
                  : `${c.element} · ${c.widthM.toFixed(2)} m`
              }
              onClick={() => setSelIdx(i === selIdx ? null : i)}
            >
              <span className="strip-label">{c.element}</span>
              <span className="strip-width">
                {c.widthM.toFixed(2)}
                {warn && ' ⚠'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
