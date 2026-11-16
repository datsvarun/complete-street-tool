// Canvas fill props for a component kind: a flat colour, or a repeating hatch
// tile sized in world metres (so the hatch scales with the drawing).
import { KIND_COLORS } from '../catalog';
import type { ComponentKind } from '../types';
import { HATCH_LINE_M, HATCH_STEP_M, HATCH_TILE_M, KIND_HATCH, hatchInk } from './kindStyles';
import type { HatchStyle } from './kindStyles';

const TILE_PX = 96;
const tiles = new Map<string, HTMLCanvasElement>();

function hatchTile(color: string, hatch: HatchStyle): HTMLCanvasElement {
  const key = `${color}|${hatch}`;
  const cached = tiles.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = TILE_PX;
  c.height = TILE_PX;
  const ctx = c.getContext('2d')!;
  const px = TILE_PX / HATCH_TILE_M; // pixels per metre
  const step = HATCH_STEP_M * px;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.strokeStyle = hatchInk(color);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = HATCH_LINE_M * px;
  ctx.beginPath();
  for (let v = 0; v <= TILE_PX; v += step) {
    if (hatch === 'horizontal' || hatch === 'cross') {
      ctx.moveTo(0, v);
      ctx.lineTo(TILE_PX, v);
    }
    if (hatch === 'cross') {
      ctx.moveTo(v, 0);
      ctx.lineTo(v, TILE_PX);
    }
  }
  if (hatch === 'diagonal') {
    for (let v = -TILE_PX; v <= TILE_PX; v += step) {
      ctx.moveTo(v, TILE_PX);
      ctx.lineTo(v + TILE_PX, 0);
    }
  }
  ctx.stroke();
  if (hatch === 'dots') {
    for (let x = step / 2; x < TILE_PX; x += step) {
      for (let y = step / 2; y < TILE_PX; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, HATCH_LINE_M * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  tiles.set(key, c);
  return c;
}

const TILE_SCALE = HATCH_TILE_M / TILE_PX;

/** Spread onto a Konva shape: `{...kindFill(kind)}`. `flat` skips the hatch
 *  (zoomed-out LOD, where it is sub-pixel noise). */
export function kindFill(kind: ComponentKind, flat = false) {
  const color = KIND_COLORS[kind];
  const hatch = KIND_HATCH[kind];
  if (flat || hatch === 'none') return { fill: color };
  return {
    fill: color,
    fillPriority: 'pattern' as const,
    fillPatternImage: hatchTile(color, hatch) as unknown as HTMLImageElement,
    fillPatternRepeat: 'repeat' as const,
    fillPatternScaleX: TILE_SCALE,
    fillPatternScaleY: TILE_SCALE,
  };
}
