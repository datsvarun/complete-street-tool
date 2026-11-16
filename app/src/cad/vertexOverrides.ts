// P3/P4 of the CAD layer (CAD_Architecture §1–§4): node-level control over
// every generated polygon without storing geometry. An override is a
// parametric nudge — (along, across) in the outline's local frame at a
// perimeter-fraction key — re-applied on every regeneration. Fractions (not
// indices) survive resampling; unmatched keys are simply skipped (stale, not
// wrong), mirroring pruneElements/pruneSelections.

/** One vertex nudge: metres along the outline tangent / across it (normal). */
export interface VertexDelta {
  a: number; // along
  c: number; // across
}

/** fraction-key ("0.3153") → delta. One record per shape. */
export type ShapeOverrides = Record<string, VertexDelta>;

/** shape-key → its vertex overrides. The undoable/persisted slice. */
export type VertexOverrides = Record<string, ShapeOverrides>;

/** Perimeter-fraction match tolerance: resampling shifts fractions slightly;
 *  beyond this the key is considered stale and skipped. */
const FRAC_TOL = 0.02;

export const fracKey = (f: number): string => f.toFixed(4);

/** Arc-length fraction of each vertex along the outline (closed: perimeter
 *  includes the closing segment; open: full path length). */
export function vertexFractions(polygon: number[], closed: boolean): number[] {
  const n = polygon.length / 2;
  if (n === 0) return [];
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(polygon[i * 2] - polygon[i * 2 - 2], polygon[i * 2 + 1] - polygon[i * 2 - 1]);
    cum.push(total);
  }
  if (closed && n > 1) {
    total += Math.hypot(polygon[0] - polygon[(n - 1) * 2], polygon[1] - polygon[(n - 1) * 2 + 1]);
  }
  if (total < 1e-9) return cum.map(() => 0);
  return cum.map((c) => c / total);
}

/** Unit tangent at vertex i (neighbour-to-neighbour direction). */
export function vertexFrame(polygon: number[], i: number, closed: boolean): { tx: number; ty: number; nx: number; ny: number } {
  const n = polygon.length / 2;
  const prev = i > 0 ? i - 1 : closed ? n - 1 : 0;
  const next = i < n - 1 ? i + 1 : closed ? 0 : n - 1;
  let tx = polygon[next * 2] - polygon[prev * 2];
  let ty = polygon[next * 2 + 1] - polygon[prev * 2 + 1];
  const len = Math.hypot(tx, ty);
  if (len < 1e-9) {
    tx = 1;
    ty = 0;
  } else {
    tx /= len;
    ty /= len;
  }
  // y-down left normal of (tx, ty) is (ty, -tx) — consistent with offsetPolyline
  return { tx, ty, nx: ty, ny: -tx };
}

/** Re-apply a shape's overrides to a freshly generated outline. Unmatched
 *  keys (resampled away, shape shrunk) are skipped. Returns the input array
 *  untouched when there is nothing to apply. */
export function applyShapeOverrides(
  polygon: number[],
  overrides: ShapeOverrides | undefined,
  closed = true,
): number[] {
  if (!overrides) return polygon;
  const entries = Object.entries(overrides);
  if (entries.length === 0) return polygon;
  const fracs = vertexFractions(polygon, closed);
  if (fracs.length === 0) return polygon;
  const out = polygon.slice();
  for (const [key, d] of entries) {
    const f = parseFloat(key);
    let bi = -1;
    let bd = FRAC_TOL;
    for (let i = 0; i < fracs.length; i++) {
      let df = Math.abs(fracs[i] - f);
      if (closed) df = Math.min(df, 1 - df); // wrap-around distance
      if (df < bd) {
        bd = df;
        bi = i;
      }
    }
    if (bi < 0) continue;
    const fr = vertexFrame(polygon, bi, closed);
    out[bi * 2] += fr.tx * d.a + fr.nx * d.c;
    out[bi * 2 + 1] += fr.ty * d.a + fr.ny * d.c;
  }
  return out;
}

/**
 * Turn a drag of displayed vertex `i` (already carrying `current` overrides)
 * to world (wx, wy) into the absolute delta to store. The frame is taken on
 * the BASE outline so repeated drags stay consistent.
 */
export function deltaForDrag(
  basePolygon: number[],
  overrides: ShapeOverrides | undefined,
  i: number,
  wx: number,
  wy: number,
  closed = true,
): { key: string; delta: VertexDelta } {
  const fracs = vertexFractions(basePolygon, closed);
  const fr = vertexFrame(basePolygon, i, closed);
  const dx = wx - basePolygon[i * 2];
  const dy = wy - basePolygon[i * 2 + 1];
  // decompose the total base→target displacement in the base frame
  const a = dx * fr.tx + dy * fr.ty;
  const c = dx * fr.nx + dy * fr.ny;
  // reuse an existing key when this vertex already has one (avoids duplicates
  // from tiny fraction drift while dragging)
  let key = fracKey(fracs[i] ?? 0);
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      let df = Math.abs(parseFloat(k) - (fracs[i] ?? 0));
      if (closed) df = Math.min(df, 1 - df);
      if (df < FRAC_TOL) {
        key = k;
        break;
      }
    }
  }
  return { key, delta: { a, c } };
}
