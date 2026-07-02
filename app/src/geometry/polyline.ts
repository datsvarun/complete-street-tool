// Minimal polyline math for the Phase 0 POC.
// Offsets use per-vertex miter joins with a clamp — adequate for gentle centerlines.
// Phase 1+ replaces this with the ported osm2streets PolyLine (Case_Study §1) and
// Clipper2 as the self-intersection safety net (Plan v2 §9.2).

export interface Pt {
  x: number;
  y: number;
}

const MITER_LIMIT = 4; // max extension factor at sharp vertices

export function toPts(flat: number[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  return pts;
}

export function toFlat(pts: Pt[]): number[] {
  return pts.flatMap((p) => [p.x, p.y]);
}

/** Drop consecutive points closer than tol (metres). */
export function dedupe(pts: Pt[], tol = 0.05): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  }
  return out;
}

export function polylineLength(flat: number[]): number {
  let len = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    len += Math.hypot(flat[i + 2] - flat[i], flat[i + 3] - flat[i + 1]);
  }
  return len;
}

/** Unit left-normal of segment a→b (y-down coords: left of travel direction). */
function leftNormal(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dy / len, y: -dx / len };
}

/**
 * Offset a polyline by signed distance d (metres). Positive = left of travel direction.
 * Interior vertices use the miter of the adjoining segment normals, clamped to MITER_LIMIT.
 */
export function offsetPolyline(pts: Pt[], d: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const nPrev = i > 0 ? leftNormal(pts[i - 1], pts[i]) : null;
    const nNext = i < pts.length - 1 ? leftNormal(pts[i], pts[i + 1]) : null;
    let nx: number, ny: number, scale: number;
    if (nPrev && nNext) {
      const mx = nPrev.x + nNext.x;
      const my = nPrev.y + nNext.y;
      const mLen = Math.hypot(mx, my);
      if (mLen < 1e-6) {
        // 180° reversal — fall back to the previous normal
        nx = nPrev.x;
        ny = nPrev.y;
        scale = 1;
      } else {
        nx = mx / mLen;
        ny = my / mLen;
        // miter length = d / cos(θ/2); cos(θ/2) = dot(miter, segment normal)
        const cosHalf = nx * nPrev.x + ny * nPrev.y;
        scale = Math.min(1 / Math.max(cosHalf, 1e-3), MITER_LIMIT);
      }
    } else {
      const n = (nPrev ?? nNext)!;
      nx = n.x;
      ny = n.y;
      scale = 1;
    }
    out.push({ x: pts[i].x + nx * d * scale, y: pts[i].y + ny * d * scale });
  }
  return out;
}

/** Closed polygon (flat coords) between two parallel offsets of the same centerline. */
export function ribbonBand(pts: Pt[], offsetLeft: number, offsetRight: number): number[] {
  const left = offsetPolyline(pts, offsetLeft);
  const right = offsetPolyline(pts, offsetRight).reverse();
  return toFlat([...left, ...right]);
}
