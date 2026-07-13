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
  const updateSectionRef = useCst((s) => s.updateSectionRef);
  const flipSection = useCst((s) => s.flipSection);
  const edge = selectedEdgeId ? edges[selectedEdgeId] : null;
  const section = edge?.section ?? null;

  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [widthText, setWidthText] = useState('');
  const [addKind, setAddKind] = useState(COMPONENT_DEFAULTS[0].element);
  const [refEdit, setRefEdit] = useState<string | null>(null); // manual centerline entry

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

  // Centerline reference marker: snaps to component edges, component centers
  // and the section midpoint (the default).
  const refM = Math.max(0, Math.min(total, section.refM ?? total / 2));
  const snapCandidates = (() => {
    const c: number[] = [0, total / 2, total];
    let cum = 0;
    for (const comp of comps) {
      c.push(cum + comp.widthM / 2);
      cum += comp.widthM;
      c.push(cum);
    }
    return [...new Set(c.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  })();

  const dragRef = (ev: React.PointerEvent<HTMLDivElement>) => {
    const track = ev.currentTarget;
    const rect = track.getBoundingClientRect();
    const toRefM = (clientX: number) => {
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = frac * total;
      let best = snapCandidates[0];
      for (const cand of snapCandidates) {
        if (Math.abs(cand - raw) < Math.abs(best - raw)) best = cand;
      }
      return best;
    };
    updateSectionRef(edge.id, toRefM(ev.clientX));
    const move = (me: PointerEvent) => updateSectionRef(edge.id, toRefM(me.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const add = () => {
    const def = COMPONENT_DEFAULTS.find((d) => d.element === addKind)!;
    const next = comps.slice();
    const at = selIdx !== null ? selIdx + 1 : comps.length;
    next.splice(at, 0, { element: def.element, widthM: def.widthM, kind: def.kind });
    update(next);
    setSelIdx(at);
  };

  // In-place swap: change the selected component's type, keeping its width.
  const swapKind = (element: string) => {
    if (selIdx === null) return;
    const def = COMPONENT_DEFAULTS.find((d) => d.element === element);
    if (!def) return;
    update(comps.map((c, i) => (i === selIdx ? { ...c, element: def.element, kind: def.kind } : c)));
  };

  const commitRef = () => {
    if (refEdit !== null) {
      const v = parseFloat(refEdit);
      if (Number.isFinite(v)) updateSectionRef(edge.id, v);
    }
    setRefEdit(null);
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
          <button onClick={() => flipSection(edge.id)} title="Mirror the section left↔right">
            ⇋ Flip
          </button>
          {sel && (
            <>
              <select
                value={COMPONENT_DEFAULTS.find((d) => d.kind === sel.kind)?.element ?? ''}
                onChange={(e) => swapKind(e.target.value)}
                title="Change this component's type in place (width stays)"
              >
                {!COMPONENT_DEFAULTS.some((d) => d.kind === sel.kind) && (
                  <option value="">{sel.element}</option>
                )}
                {COMPONENT_DEFAULTS.map((d) => (
                  <option key={d.element} value={d.element}>
                    {d.element}
                  </option>
                ))}
              </select>
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
      <div
        className="ref-track"
        onPointerDown={refEdit === null ? dragRef : undefined}
        title="Drag: where the drawn centerline sits (snaps to component edges, centers, and the middle) · click the number to type it"
      >
        <div className="ref-marker" style={{ left: `${(refM / Math.max(total, 0.01)) * 100}%` }}>
          <span className="ref-arrow">▲</span>
          {refEdit === null ? (
            <span
              className="ref-label editable"
              title="Click to type an exact centerline position"
              onPointerDown={(e) => {
                e.stopPropagation();
                setRefEdit(refM.toFixed(2));
              }}
            >
              {refM.toFixed(2)} m
            </span>
          ) : (
            <input
              className="ref-input"
              autoFocus
              value={refEdit}
              onChange={(e) => setRefEdit(e.target.value)}
              onBlur={commitRef}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRef();
                if (e.key === 'Escape') setRefEdit(null);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
        </div>
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
