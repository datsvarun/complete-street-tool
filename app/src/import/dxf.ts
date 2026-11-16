// Minimal ASCII DXF reader for street centerlines: LINE, LWPOLYLINE,
// POLYLINE/VERTEX and ARC entities from the ENTITIES section. Blocks,
// splines, bulges and text are skipped. DXF is y-up; the app is y-down, so y
// flips here. Drawing units come from $INSUNITS (default: metres).
import type { ImportLine } from './lines';

const UNIT_TO_M: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 7: 1000 };
const ARC_STEP = (10 * Math.PI) / 180;

type Pair = [number, string];

export function parseDxf(text: string): ImportLine[] {
  const rows = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) pairs.push([parseInt(rows[i].trim(), 10), rows[i + 1].trim()]);

  // Index of the next entity boundary (group code 0) at or after `start`.
  const bodyEnd = (start: number) => {
    let j = start;
    while (j < pairs.length && pairs[j][0] !== 0) j++;
    return j;
  };
  const first = (g: Pair[], c: number) => parseFloat(g.find((p) => p[0] === c)?.[1] ?? 'NaN');

  let scale = 1;
  const raw: number[][] = [];
  let section = '';
  let i = 0;
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code === 0 && value === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      section = pairs[i + 1][1];
      i += 2;
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS' && pairs[i + 1]?.[0] === 70) {
      scale = UNIT_TO_M[parseInt(pairs[i + 1][1], 10)] ?? 1;
    }
    if (section !== 'ENTITIES' || code !== 0) {
      i++;
      continue;
    }
    const end = bodyEnd(i + 1);
    const g = pairs.slice(i + 1, end);
    if (value === 'LINE') {
      raw.push([first(g, 10), first(g, 20), first(g, 11), first(g, 21)]);
    } else if (value === 'LWPOLYLINE') {
      const pts: number[] = [];
      for (let k = 0; k + 1 < g.length; k++) {
        if (g[k][0] === 10 && g[k + 1][0] === 20) pts.push(parseFloat(g[k][1]), parseFloat(g[k + 1][1]));
      }
      if ((first(g, 70) & 1) === 1 && pts.length >= 4) pts.push(pts[0], pts[1]);
      raw.push(pts);
    } else if (value === 'POLYLINE') {
      const closed = (first(g, 70) & 1) === 1;
      const pts: number[] = [];
      let j = end;
      while (j < pairs.length && pairs[j][0] === 0 && pairs[j][1] === 'VERTEX') {
        const vEnd = bodyEnd(j + 1);
        const v = pairs.slice(j + 1, vEnd);
        pts.push(first(v, 10), first(v, 20));
        j = vEnd;
      }
      if (closed && pts.length >= 4) pts.push(pts[0], pts[1]);
      raw.push(pts);
      i = j;
      continue;
    } else if (value === 'ARC') {
      const cx = first(g, 10);
      const cy = first(g, 20);
      const r = first(g, 40);
      const a0 = (first(g, 50) * Math.PI) / 180;
      let a1 = (first(g, 51) * Math.PI) / 180;
      if (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(2, Math.ceil((a1 - a0) / ARC_STEP));
      const pts: number[] = [];
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      raw.push(pts);
    }
    i = end;
  }

  return raw
    .filter((p) => p.length >= 4 && p.every(Number.isFinite))
    .map((p) => ({ points: p.map((v, k) => (k % 2 === 0 ? v * scale : -v * scale)) }));
}

/** Shift lines so their bounding-box centre sits on (cx, cy). */
export function centerLines(lines: ImportLine[], cx = 0, cy = 0): ImportLine[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of lines) {
    for (let k = 0; k + 1 < l.points.length; k += 2) {
      minX = Math.min(minX, l.points[k]);
      maxX = Math.max(maxX, l.points[k]);
      minY = Math.min(minY, l.points[k + 1]);
      maxY = Math.max(maxY, l.points[k + 1]);
    }
  }
  if (!Number.isFinite(minX)) return lines;
  const dx = cx - (minX + maxX) / 2;
  const dy = cy - (minY + maxY) / 2;
  return lines.map((l) => ({ ...l, points: l.points.map((v, k) => v + (k % 2 === 0 ? dx : dy)) }));
}
