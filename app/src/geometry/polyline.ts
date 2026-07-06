// Minimal polyline math for Phases 0–1.
// Offsets use per-vertex miter joins with a clamp — adequate for gentle centerlines.
// Later phases replace this with the ported osm2streets PolyLine (Case_Study §1) and
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

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
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

/** Overall bearing (degrees CW from north, y-down) from first to last point. */
export function bearing(flat: number[]): number {
  const dx = flat[flat.length - 2] - flat[0];
  const dy = flat[flat.length - 1] - flat[1];
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function bearingDiff(b1: number, b2: number): number {
  const d = Math.abs(((b1 - b2) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export interface Projection {
  x: number;
  y: number;
  dist: number;     // distance from query point to projection
  segIdx: number;   // segment index (points[segIdx] → points[segIdx+1])
  t: number;        // param within that segment [0,1]
  station: number;  // arc length from start of polyline
}

/** Closest point on a flat polyline to (px, py). */
export function projectOnPolyline(flat: number[], px: number, py: number): Projection | null {
  let best: Projection | null = null;
  let station = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const ax = flat[i], ay = flat[i + 1], bx = flat[i + 2], by = flat[i + 3];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    const d = Math.hypot(px - x, py - y);
    if (!best || d < best.dist) {
      best = { x, y, dist: d, segIdx: i / 2, t, station: station + t * segLen };
    }
    station += segLen;
  }
  return best;
}

export interface SegHit {
  x: number;
  y: number;
  t: number; // param on segment a1→a2
  u: number; // param on segment b1→b2
}

/** Proper intersection of two segments (excludes parallel/collinear). */
export function segSegIntersection(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
): SegHit | null {
  const d1x = a2x - a1x, d1y = a2y - a1y;
  const d2x = b2x - b1x, d2y = b2y - b1y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1x - a1x) * d2y - (b1y - a1y) * d2x) / denom;
  const u = ((b1x - a1x) * d1y - (b1y - a1y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1x + t * d1x, y: a1y + t * d1y, t, u };
}

/** Douglas-Peucker simplification of interior vertices; endpoints preserved. */
export function douglasPeucker(pts: Pt[], tolM: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let maxD = -1, maxI = -1;
    const a = pts[i0], b = pts[i1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const abLen = Math.hypot(abx, aby);
    for (let i = i0 + 1; i < i1; i++) {
      const d =
        abLen < 1e-9
          ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y)
          : Math.abs((pts[i].x - a.x) * aby - (pts[i].y - a.y) * abx) / abLen;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolM) {
      keep[maxI] = true;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Resample a polyline to n evenly spaced points (arc-length parameterization). */
export function resample(flat: number[], n: number): Pt[] {
  const pts = toPts(flat);
  const total = polylineLength(flat);
  if (pts.length < 2 || total < 1e-9) return pts.slice();
  const out: Pt[] = [pts[0]];
  let segIdx = 0;
  let acc = 0; // arc length consumed before current segment
  for (let k = 1; k < n - 1; k++) {
    const target = (total * k) / (n - 1);
    while (segIdx < pts.length - 2) {
      const segLen = Math.hypot(pts[segIdx + 1].x - pts[segIdx].x, pts[segIdx + 1].y - pts[segIdx].y);
      if (acc + segLen >= target) break;
      acc += segLen;
      segIdx++;
    }
    const a = pts[segIdx], b = pts[segIdx + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const t = segLen < 1e-9 ? 0 : (target - acc) / segLen;
    out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export interface StationPoint {
  x: number;
  y: number;
  nx: number; // unit left-normal at this station
  ny: number;
}

/** Point + left normal at arc-length station s (clamped to the polyline). */
export function pointAtStation(flat: number[], s: number): StationPoint {
  const pts = toPts(flat);
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segLen >= s || i === pts.length - 2) {
      const t = segLen < 1e-9 ? 0 : Math.max(0, Math.min(1, (s - acc) / segLen));
      const n = leftNormal(a, b);
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), nx: n.x, ny: n.y };
    }
    acc += segLen;
  }
  const n = pts.length >= 2 ? leftNormal(pts[0], pts[1]) : { x: 0, y: -1 };
  return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, nx: n.x, ny: n.y };
}

/** Extract the sub-polyline between stations s0 < s1 (both clamped). */
export function subPolyline(flat: number[], s0: number, s1: number): number[] {
  const pts = toPts(flat);
  const out: Pt[] = [];
  const p0 = pointAtStation(flat, s0);
  out.push({ x: p0.x, y: p0.y });
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const end = acc + segLen;
    if (end > s0 && end < s1) out.push(b);
    acc = end;
    if (acc >= s1) break;
  }
  const p1 = pointAtStation(flat, s1);
  out.push({ x: p1.x, y: p1.y });
  return toFlat(dedupe(out, 0.01));
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
