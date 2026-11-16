// Drawing style: one colour and one hatch per component kind.
//
// KIND_COLORS (catalog.ts) and KIND_HATCH (here) are the LIVE palette that
// every renderer reads — canvas, SVG export and 3D. `applyKindStyles` rewrites
// both in place; the store keeps the same data as `kindStyles` so React
// components can subscribe and re-render when the style changes.
import { KIND_COLORS } from '../catalog';
import type { ComponentKind } from '../types';

export type HatchStyle = 'none' | 'diagonal' | 'cross' | 'horizontal' | 'dots';

export const HATCH_LABELS: Record<HatchStyle, string> = {
  none: 'Solid',
  diagonal: 'Diagonal',
  cross: 'Grid',
  horizontal: 'Lines',
  dots: 'Dots',
};

export interface KindStyle {
  color: string; // #rrggbb
  hatch: HatchStyle;
}

export type KindStyles = Record<ComponentKind, KindStyle>;

const KINDS = Object.keys(KIND_COLORS) as ComponentKind[];

/** The original flat palette (captured before any style is applied). */
const CLASSIC: KindStyles = Object.fromEntries(
  KINDS.map((k) => [k, { color: KIND_COLORS[k], hatch: 'none' }]),
) as KindStyles;

/** Default: soft pastel fills, with hatches telling apart the surfaces that
 *  are not plain running lanes. */
const PASTEL: KindStyles = {
  carriageway: { color: '#a9b2bc', hatch: 'none' },
  mixed: { color: '#f0b3ab', hatch: 'none' },
  service: { color: '#c3cad2', hatch: 'none' },
  brt: { color: '#e89d94', hatch: 'horizontal' },
  busstop: { color: '#f5d79b', hatch: 'diagonal' },
  parking: { color: '#c5d3ea', hatch: 'diagonal' },
  cycle: { color: '#a8dcb6', hatch: 'none' },
  footpath: { color: '#f2ecdf', hatch: 'cross' },
  muz: { color: '#ead8b5', hatch: 'horizontal' },
  mfz: { color: '#f1dfae', hatch: 'horizontal' },
  buffer: { color: '#cde6bd', hatch: 'diagonal' },
  tree: { color: '#b3dba4', hatch: 'dots' },
  livability: { color: '#d6ecc6', hatch: 'dots' },
  median: { color: '#bbd9ad', hatch: 'diagonal' },
  metro: { color: '#d4ccec', hatch: 'cross' },
  other: { color: '#e3e3e3', hatch: 'none' },
};

export const STYLE_PRESETS = { pastel: PASTEL, classic: CLASSIC } as const;
export type StylePreset = keyof typeof STYLE_PRESETS;
export const DEFAULT_STYLES: KindStyles = PASTEL;

export const KIND_HATCH: Record<ComponentKind, HatchStyle> = Object.fromEntries(
  KINDS.map((k) => [k, 'none']),
) as Record<ComponentKind, HatchStyle>;

export function applyKindStyles(styles: KindStyles): void {
  for (const k of KINDS) {
    KIND_COLORS[k] = styles[k].color;
    KIND_HATCH[k] = styles[k].hatch;
  }
}

/** Fill in kinds missing from a stored style (older saves, new kinds). */
export function completeStyles(partial: Partial<Record<ComponentKind, Partial<KindStyle>>> | null): KindStyles {
  return Object.fromEntries(
    KINDS.map((k) => [k, { ...DEFAULT_STYLES[k], ...(partial?.[k] ?? {}) }]),
  ) as KindStyles;
}

function channels(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix a colour toward white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return (
    '#' +
    channels(hex)
      .map((c) => Math.round(c + (target - c) * t).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Hatch line colour: darker on light fills, lighter on dark fills. */
export function hatchInk(color: string): string {
  const [r, g, b] = channels(color);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return shade(color, luminance > 0.45 ? -0.22 : 0.28);
}

/** Junction surfaces follow the carriageway colour, a touch lighter. */
export function junctionColor(): string {
  return shade(KIND_COLORS.carriageway, 0.05);
}

// ── Hatch geometry (shared by the canvas tile and the SVG pattern) ───────

export const HATCH_TILE_M = 2; // one pattern tile covers 2 × 2 m
export const HATCH_STEP_M = 0.5; // spacing between hatch lines
export const HATCH_LINE_M = 0.07;

/** Paint for an SVG fill attribute: a flat colour, or a pattern reference. */
export function svgFill(kind: ComponentKind): string {
  return KIND_HATCH[kind] === 'none' ? KIND_COLORS[kind] : `url(#hatch-${kind})`;
}

/** <defs> with one <pattern> per hatched kind, in world metres. */
export function svgHatchDefs(): string {
  const T = HATCH_TILE_M;
  const S = HATCH_STEP_M;
  const out: string[] = [];
  for (const k of KINDS) {
    const hatch = KIND_HATCH[k];
    if (hatch === 'none') continue;
    const ink = hatchInk(KIND_COLORS[k]);
    const line = (x1: number, y1: number, x2: number, y2: number) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ink}" stroke-width="${HATCH_LINE_M}"/>`;
    const marks: string[] = [];
    for (let v = 0; v <= T + 1e-9; v += S) {
      if (hatch === 'horizontal' || hatch === 'cross') marks.push(line(0, v, T, v));
      if (hatch === 'cross') marks.push(line(v, 0, v, T));
    }
    if (hatch === 'diagonal') {
      for (let v = -T; v <= T + 1e-9; v += S) marks.push(line(v, T, v + T, 0));
    }
    if (hatch === 'dots') {
      for (let x = S / 2; x < T; x += S) {
        for (let y = S / 2; y < T; y += S) marks.push(`<circle cx="${x}" cy="${y}" r="${HATCH_LINE_M}" fill="${ink}"/>`);
      }
    }
    out.push(
      `<pattern id="hatch-${k}" patternUnits="userSpaceOnUse" width="${T}" height="${T}">` +
        `<rect width="${T}" height="${T}" fill="${KIND_COLORS[k]}"/>${marks.join('')}</pattern>`,
    );
  }
  return out.length ? `<defs>${out.join('')}</defs>` : '';
}
