// Canvas fill props for a component kind: a flat colour, or a repeating hatch
// tile sized in world metres (so the hatch scales with the drawing).
import { KIND_COLORS } from '../catalog';
import type { ComponentKind } from '../types';
import { KIND_HATCH, KIND_INK, hatchSpec } from './kindStyles';
import type { HatchStyle } from './kindStyles';

const PX_PER_M = 48;
const tiles = new Map<string, HTMLCanvasElement>();

function hatchTile(color: string, ink: string, hatch: Exclude<HatchStyle, 'none'>): HTMLCanvasElement {
  const key = `${color}|${ink}|${hatch}`;
  const cached = tiles.get(key);
  if (cached) return cached;
  const { tileM, opacity, marks } = hatchSpec(hatch);
  const size = Math.round(tileM * PX_PER_M);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  ctx.scale(PX_PER_M, PX_PER_M); // draw in metres from here on
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  for (const m of marks) {
    ctx.beginPath();
    if (m.t === 'line') {
      ctx.lineWidth = m.w;
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
    } else if (m.t === 'ring') {
      ctx.lineWidth = m.w;
      ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.t === 'dot') {
      ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(m.x, m.y, m.w, m.h);
    }
  }
  tiles.set(key, c);
  return c;
}

/** Spread onto a Konva shape: `{...kindFill(kind)}`. `flat` skips the hatch
 *  (zoomed-out LOD, where it is sub-pixel noise). */
export function kindFill(kind: ComponentKind, flat = false) {
  const color = KIND_COLORS[kind];
  const hatch = KIND_HATCH[kind];
  if (flat || hatch === 'none') return { fill: color };
  return {
    fill: color,
    fillPriority: 'pattern' as const,
    fillPatternImage: hatchTile(color, KIND_INK[kind], hatch) as unknown as HTMLImageElement,
    fillPatternRepeat: 'repeat' as const,
    fillPatternScaleX: 1 / PX_PER_M,
    fillPatternScaleY: 1 / PX_PER_M,
  };
}
