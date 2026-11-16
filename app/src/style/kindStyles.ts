// Drawing style: one colour and one hatch per component kind.
//
// KIND_COLORS (catalog.ts) and KIND_HATCH (here) are the LIVE palette that
// every renderer reads — canvas, SVG export and 3D. `applyKindStyles` rewrites
// both in place; the store keeps the same data as `kindStyles` so React
// components can subscribe and re-render when the style changes.
import { KIND_COLORS } from '../catalog';
import type { ComponentKind } from '../types';

export type HatchStyle = 'none' | 'diagonal' | 'rings' | 'dots' | 'finedots' | 'brick' | 'weave' | 'cross' | 'horizontal';

export const HATCH_LABELS: Record<HatchStyle, string> = {
  none: 'Solid',
  diagonal: 'Diagonal stripes',
  rings: 'Rings (grass)',
  dots: 'Dots (stone)',
  finedots: 'Fine dots (planting)',
  brick: 'Brick',
  weave: 'Paving weave',
  cross: 'Grid',
  horizontal: 'Lines',
};

export interface KindStyle {
  color: string; // fill, #rrggbb
  hatch: HatchStyle;
  ink: string; // hatch line colour, #rrggbb
}

export type KindStyles = Record<ComponentKind, KindStyle>;

const KINDS = Object.keys(KIND_COLORS) as ComponentKind[];

/** The original flat palette (captured before any style is applied). */
const CLASSIC: KindStyles = Object.fromEntries(
  KINDS.map((k) => [k, { color: KIND_COLORS[k], hatch: 'none', ink: hatchInk(KIND_COLORS[k]) }]),
) as KindStyles;

// Surface colours of the default style.
const ASPHALT = '#bfbfbf';
const BUS_RED = '#f77471';
const CYCLE_GREEN = '#7ccd93';
const GRASS = '#d6eaa9';
const PLANTING = '#569f54';
const STONE = '#eeeeee';
const SAND = '#dfd1b6';
const WHITE = '#ffffff';

/** Default: light pastel surfaces — grey asphalt, white footpaths, green
 *  cycle tracks, red bus lanes — with hatches on buffers, verges and paving. */
const PASTEL: KindStyles = {
  carriageway: { color: ASPHALT, hatch: 'none', ink: WHITE },
  mixed: { color: BUS_RED, hatch: 'none', ink: WHITE },
  service: { color: ASPHALT, hatch: 'none', ink: WHITE },
  brt: { color: BUS_RED, hatch: 'none', ink: WHITE },
  busstop: { color: STONE, hatch: 'dots', ink: '#222222' },
  parking: { color: ASPHALT, hatch: 'none', ink: WHITE },
  cycle: { color: CYCLE_GREEN, hatch: 'none', ink: WHITE },
  footpath: { color: WHITE, hatch: 'none', ink: '#dcdbdc' },
  muz: { color: STONE, hatch: 'dots', ink: '#222222' },
  mfz: { color: STONE, hatch: 'dots', ink: '#222222' },
  buffer: { color: ASPHALT, hatch: 'diagonal', ink: WHITE },
  tree: { color: PLANTING, hatch: 'finedots', ink: '#1a1f22' },
  livability: { color: GRASS, hatch: 'rings', ink: WHITE },
  median: { color: GRASS, hatch: 'rings', ink: WHITE },
  metro: { color: SAND, hatch: 'none', ink: WHITE },
  other: { color: WHITE, hatch: 'weave', ink: '#dcdbdc' },
};

export const STYLE_PRESETS = { pastel: PASTEL, classic: CLASSIC } as const;
export type StylePreset = keyof typeof STYLE_PRESETS;
export const DEFAULT_STYLES: KindStyles = PASTEL;

export const KIND_HATCH: Record<ComponentKind, HatchStyle> = Object.fromEntries(
  KINDS.map((k) => [k, 'none']),
) as Record<ComponentKind, HatchStyle>;

export const KIND_INK: Record<ComponentKind, string> = Object.fromEntries(
  KINDS.map((k) => [k, '#ffffff']),
) as Record<ComponentKind, string>;

export function applyKindStyles(styles: KindStyles): void {
  for (const k of KINDS) {
    KIND_COLORS[k] = styles[k].color;
    KIND_HATCH[k] = styles[k].hatch;
    KIND_INK[k] = styles[k].ink;
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

/** A readable hatch line colour for a fill: darker on light, lighter on dark. */
export function hatchInk(color: string): string {
  const [r, g, b] = channels(color);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return shade(color, luminance > 0.45 ? -0.22 : 0.28);
}

/** Junction surfaces follow the carriageway colour, a touch lighter. */
export function junctionColor(): string {
  return shade(KIND_COLORS.carriageway, 0.05);
}

// ── Hatch geometry ───────────────────────────────────────────────────────
// One description per hatch, in METRES, drawn by both the canvas tile
// (hatchTile.ts) and the SVG pattern below — so screen and export agree and
// every hatch keeps its real-world size at any zoom.

export type HatchMark =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number }
  | { t: 'ring'; cx: number; cy: number; r: number; w: number }
  | { t: 'dot'; cx: number; cy: number; r: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number };

export interface HatchSpec {
  tileM: number; // the pattern repeats every tileM × tileM metres
  opacity: number;
  marks: HatchMark[];
}

/** Staggered two-row lattice: 4 columns × 4 rows, alternate rows offset. */
function staggered(tileM: number, make: (cx: number, cy: number) => HatchMark): HatchMark[] {
  const u = tileM / 24;
  const out: HatchMark[] = [];
  for (const [cx, cy] of [[2, 2], [14, 2], [8, 8], [20, 8], [2, 14], [14, 14], [8, 20], [20, 20]]) {
    out.push(make(cx * u, cy * u));
  }
  return out;
}

function grid(tileM: number, stepM: number, w: number, both: boolean): HatchMark[] {
  const out: HatchMark[] = [];
  for (let v = 0; v <= tileM + 1e-9; v += stepM) {
    out.push({ t: 'line', x1: 0, y1: v, x2: tileM, y2: v, w });
    if (both) out.push({ t: 'line', x1: v, y1: 0, x2: v, y2: tileM, w });
  }
  return out;
}

function brick(tileM: number): HatchMark[] {
  const u = tileM / 32; // 4 courses of 8u; bricks 16u long, 1u joints
  const out: HatchMark[] = [];
  for (let row = 0; row < 4; row++) {
    out.push({ t: 'rect', x: 0, y: (row * 8 + 7) * u, w: tileM, h: u });
    for (const x of row % 2 === 0 ? [7, 23] : [0, 16]) out.push({ t: 'rect', x: x * u, y: row * 8 * u, w: u, h: 7 * u });
  }
  return out;
}

function weave(tileM: number): HatchMark[] {
  const u = tileM / 20; // short dashes, alternating upright and flat
  const out: HatchMark[] = [];
  for (const [x, y] of [[2, 0], [12, 0], [7, 5], [17, 5], [2, 10], [12, 10], [7, 15], [17, 15]]) {
    out.push({ t: 'rect', x: x * u, y: y * u, w: u, h: 5 * u });
  }
  for (const [x, y] of [[5, 2], [15, 2], [0, 7], [10, 7], [5, 12], [15, 12], [0, 17], [10, 17]]) {
    out.push({ t: 'rect', x: x * u, y: y * u, w: 5 * u, h: u });
  }
  return out;
}

export function hatchSpec(hatch: Exclude<HatchStyle, 'none'>): HatchSpec {
  switch (hatch) {
    case 'diagonal': {
      const w = 0.25; // one 45° stripe per 2 m tile, plus the two corner halves
      return {
        tileM: 2,
        opacity: 1,
        marks: [
          { t: 'line', x1: -0.5, y1: 0.5, x2: 0.5, y2: -0.5, w },
          { t: 'line', x1: 0, y1: 2, x2: 2, y2: 0, w },
          { t: 'line', x1: 1.5, y1: 2.5, x2: 2.5, y2: 1.5, w },
        ],
      };
    }
    case 'rings':
      return { tileM: 1.5, opacity: 1, marks: staggered(1.5, (cx, cy) => ({ t: 'ring', cx, cy, r: 0.094, w: 0.031 })) };
    case 'dots':
      return { tileM: 1, opacity: 1, marks: staggered(1, (cx, cy) => ({ t: 'ring', cx, cy, r: 0.021, w: 0.021 })) };
    case 'finedots':
      return {
        tileM: 0.5,
        opacity: 0.6,
        marks: [
          { t: 'ring', cx: 0.0625, cy: 0.0625, r: 0.0417, w: 0.0417 },
          { t: 'ring', cx: 0.3125, cy: 0.3125, r: 0.0417, w: 0.0417 },
        ],
      };
    case 'brick':
      return { tileM: 1.5, opacity: 0.6, marks: brick(1.5) };
    case 'weave':
      return { tileM: 2.5, opacity: 1, marks: weave(2.5) };
    case 'cross':
      return { tileM: 2, opacity: 1, marks: grid(2, 0.5, 0.07, true) };
    case 'horizontal':
      return { tileM: 2, opacity: 1, marks: grid(2, 0.5, 0.07, false) };
  }
}

/** Paint for an SVG fill attribute: a flat colour, or a pattern reference. */
export function svgFill(kind: ComponentKind): string {
  return KIND_HATCH[kind] === 'none' ? KIND_COLORS[kind] : `url(#hatch-${kind})`;
}

const n3 = (v: number) => Math.round(v * 1000) / 1000;

/** <defs> with one <pattern> per hatched kind, in world metres. */
export function svgHatchDefs(): string {
  const out: string[] = [];
  for (const k of KINDS) {
    const hatch = KIND_HATCH[k];
    if (hatch === 'none') continue;
    const { tileM: T, opacity, marks } = hatchSpec(hatch);
    const ink = KIND_INK[k];
    const body = marks
      .map((m) => {
        if (m.t === 'line') {
          return `<line x1="${n3(m.x1)}" y1="${n3(m.y1)}" x2="${n3(m.x2)}" y2="${n3(m.y2)}" stroke="${ink}" stroke-width="${n3(m.w)}"/>`;
        }
        if (m.t === 'ring') {
          return `<circle cx="${n3(m.cx)}" cy="${n3(m.cy)}" r="${n3(m.r)}" fill="none" stroke="${ink}" stroke-width="${n3(m.w)}"/>`;
        }
        if (m.t === 'dot') return `<circle cx="${n3(m.cx)}" cy="${n3(m.cy)}" r="${n3(m.r)}" fill="${ink}"/>`;
        return `<rect x="${n3(m.x)}" y="${n3(m.y)}" width="${n3(m.w)}" height="${n3(m.h)}" fill="${ink}"/>`;
      })
      .join('');
    out.push(
      `<pattern id="hatch-${k}" patternUnits="userSpaceOnUse" width="${T}" height="${T}">` +
        `<rect width="${T}" height="${T}" fill="${KIND_COLORS[k]}"/><g opacity="${opacity}">${body}</g></pattern>`,
    );
  }
  return out.length ? `<defs>${out.join('')}</defs>` : '';
}
