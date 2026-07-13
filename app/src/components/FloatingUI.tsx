// Floating map-app chrome: vertical stage rail, contextual tool rail,
// basemap FAB, reactive scale bar, compass. Everything overlays the canvas —
// panels are windows the rail opens, not a fixed sidebar.
import { useEffect, useRef, useState } from 'react';
import { LAYER_LABELS, useCst } from '../store';
import type { Basemap, LayerKey } from '../store';
import type { Stage, Tool } from '../types';

const STAGES: Array<{ id: Stage; label: string; icon: string; hint: string }> = [
  { id: 'network', label: 'Network', icon: '◈', hint: 'Draw & edit the street network (1)' },
  { id: 'sections', label: 'Street', icon: '☰', hint: 'Assign cross-sections (2)' },
  { id: 'junctions', label: 'Junction', icon: '✚', hint: 'Fillets, trims & movements (3)' },
  { id: 'mesh', label: 'Mesh', icon: '⬡', hint: 'Node-mesh editing — reshape everything (4)' },
  { id: 'detailing', label: 'Detail', icon: '❖', hint: 'Furniture, markings, crossings (5)' },
  { id: 'edit', label: 'Edit', icon: '✦', hint: 'Free-form shape patches & cuts (6)' },
  { id: 'export', label: 'Export', icon: '⇩', hint: 'Print or download the plan (7)' },
];

export function StageRail({
  panelOpen,
  onToggle,
}: {
  panelOpen: boolean;
  onToggle: (open: boolean) => void;
}) {
  const stage = useCst((s) => s.stage);
  const setStage = useCst((s) => s.setStage);
  return (
    <nav className="stage-rail overlay">
      {STAGES.map((s) => (
        <button
          key={s.id}
          className={stage === s.id ? 'rail-btn active' : 'rail-btn'}
          title={s.hint}
          onClick={() => {
            if (stage === s.id) onToggle(!panelOpen);
            else {
              setStage(s.id);
              onToggle(true);
            }
          }}
        >
          <span className="rail-icon">{s.icon}</span>
          <span className="rail-label">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

type ToolDef = { id: Tool; icon: string; label: string; hint: string; stages?: Stage[] };

// Grouped by function: selection tools | editing tools.
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select', icon: '➤', label: 'Select', hint: 'Selection — click streets, Shift adds, Ctrl toggles (V)' },
    { id: 'direct', icon: '▷', label: 'Direct', hint: 'Direct selection — move nodes and vertices (A)', stages: ['network'] },
    { id: 'marquee', icon: '▭', label: 'Rect', hint: 'Rectangle select — drag a box (M)' },
    { id: 'lasso', icon: '◌', label: 'Lasso', hint: 'Lasso select — draw around streets (L)' },
  ],
  [
    { id: 'draw', icon: '✎', label: 'Draw', hint: 'Draw streets (D)', stages: ['network', 'sections'] },
    { id: 'split', icon: '✂', label: 'Split', hint: 'Split a street at a point (X)', stages: ['network', 'sections'] },
    { id: 'erase', icon: '⌫', label: 'Delete', hint: 'Delete — click a street or node to remove it (E)', stages: ['network', 'sections'] },
  ],
];

/** Standard tools live in the top bar; stage panels keep only their own
 *  domain-specific choices. Stage-inapplicable tools disable, not hide. */
export function TopToolbar() {
  const stage = useCst((s) => s.stage);
  const tool = useCst((s) => s.tool);
  const setTool = useCst((s) => s.setTool);
  if (stage === 'export') return <div className="top-toolbar" />;
  return (
    <div className="top-toolbar">
      {TOOL_GROUPS.map((group, gi) => (
        <div className="tt-group" key={gi}>
          {group.map((t) => {
            const enabled = !t.stages || t.stages.includes(stage);
            return (
              <button
                key={t.id}
                className={tool === t.id ? 'tt-btn active' : 'tt-btn'}
                title={t.hint + (enabled ? '' : ' — Network stage only')}
                disabled={!enabled}
                onClick={() => setTool(tool === t.id ? 'select' : t.id)}
              >
                <span className="tt-icon">{t.icon}</span>
                <span className="tt-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const LAYER_ICONS: Record<LayerKey, string> = {
  roads: '▤',
  junctions: '✚',
  furniture: '❖',
  markings: '≣',
  patches: '✦',
  boundaries: '⌐',
};

/** Right-edge layer rail: show/hide groups of derived geometry. Collapsible
 *  so it never fights the compass or the panel for space. */
export function LayerRail() {
  const layers = useCst((s) => s.layers);
  const toggleLayer = useCst((s) => s.toggleLayer);
  const [open, setOpen] = useState(false);
  return (
    <div className="layer-rail overlay">
      <button
        className={open ? 'rail-btn active' : 'rail-btn'}
        title="Layers — show/hide roads, furniture, decals, boundaries"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rail-icon">≡</span>
        <span className="rail-label">Layers</span>
      </button>
      {open &&
        (Object.keys(LAYER_LABELS) as LayerKey[]).map((k) => (
          <button
            key={k}
            className={layers[k] ? 'rail-btn' : 'rail-btn off'}
            title={`${layers[k] ? 'Hide' : 'Show'} ${LAYER_LABELS[k].toLowerCase()}`}
            onClick={() => toggleLayer(k)}
          >
            <span className="rail-icon small">{layers[k] ? LAYER_ICONS[k] : '·'}</span>
            <span className="rail-label">{LAYER_LABELS[k].split(' ')[0]}</span>
          </button>
        ))}
    </div>
  );
}

const BASEMAPS: Array<{ id: Basemap; label: string; icon: string }> = [
  { id: 'none', label: 'None', icon: '▦' },
  { id: 'osm', label: 'OSM', icon: '🗺' },
  { id: 'sat', label: 'Satellite', icon: '🛰' },
];

export function BasemapFab() {
  const basemap = useCst((s) => s.basemap);
  const setBasemap = useCst((s) => s.setBasemap);
  const origin = useCst((s) => s.origin);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const cur = BASEMAPS.find((b) => b.id === basemap)!;
  return (
    <div className="basemap-fab" ref={ref}>
      {open && (
        <div className="fab-popover">
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              className={b.id === basemap ? 'active' : ''}
              onClick={() => {
                setBasemap(b.id);
                setOpen(false);
              }}
            >
              <span>{b.icon}</span> {b.label}
            </button>
          ))}
          {basemap !== 'none' && !origin && (
            <div className="fab-note">Search a place or import to anchor the map</div>
          )}
        </div>
      )}
      <button className="fab" title="Basemap" onClick={() => setOpen((o) => !o)}>
        {cur.icon}
      </button>
    </div>
  );
}

/** Round scale-bar length: 1/2/5 × 10^k metres targeting ~90 px. */
function niceBar(scale: number): { m: number; px: number } {
  const target = 90 / scale; // metres
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(target, 0.1))));
  const n = target / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  const m = step * pow;
  return { m, px: m * scale };
}

export function ScaleBar({ scale }: { scale: number }) {
  const { m, px } = niceBar(scale);
  const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  return (
    <div className="scale-bar" title={`${scale.toFixed(1)} px/m`}>
      <div className="scale-line" style={{ width: `${px}px` }} />
      <span>{label}</span>
    </div>
  );
}

export function CompassRose() {
  const fitAll = useCst((s) => s.fitAll);
  return (
    <button
      className="compass overlay"
      title="North-up view · click to fit the whole network (F)"
      onClick={fitAll}
    >
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="18" fill="rgba(255,255,255,0.94)" stroke="#c9c3b4" strokeWidth="1" />
        <text x="20" y="11.5" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#212a33">
          N
        </text>
        <polygon points="20,13.5 23.4,25 20,22.6 16.6,25" fill="#d97a2e" />
        <polygon points="20,31.5 23.4,25 20,27.4 16.6,25" fill="#98a2ad" />
        <circle cx="20" cy="24.2" r="1.1" fill="#212a33" />
      </svg>
    </button>
  );
}
