// P1 of the CAD layer (CAD_Architecture §6): a uniform-grid spatial index so
// hit-testing stays O(local) instead of O(edges). The index is derived, never
// stored — rebuilt per graph snapshot and memoized by object identity, the
// same discipline as deriveNodeArtifactsCached.
import type { GraphState, StreetEdge } from '../types';

const CELL = 40; // metres — city-block sized; queries touch a handful of cells

interface Grid {
  cells: Map<string, Set<string>>; // "cx:cy" → edge ids whose bbox touches the cell
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function buildGrid(edges: Record<string, StreetEdge>): Grid {
  const cells = new Map<string, Set<string>>();
  for (const e of Object.values(edges)) {
    const p = e.points;
    // Rasterize per segment bbox: cheap and tight enough for street polylines.
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = Math.floor(Math.min(p[i], p[i + 2]) / CELL);
      const x1 = Math.floor(Math.max(p[i], p[i + 2]) / CELL);
      const y0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / CELL);
      const y1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = cellKey(cx, cy);
          let set = cells.get(k);
          if (!set) {
            set = new Set();
            cells.set(k, set);
          }
          set.add(e.id);
        }
      }
    }
  }
  return { cells };
}

// Memoized on the edges record identity — every store mutation replaces it.
const gridCache = new WeakMap<Record<string, StreetEdge>, Grid>();

function gridFor(edges: Record<string, StreetEdge>): Grid {
  let g = gridCache.get(edges);
  if (!g) {
    g = buildGrid(edges);
    gridCache.set(edges, g);
  }
  return g;
}

/** Edge ids whose geometry may lie within `r` of (x, y). Superset (bbox-level);
 *  callers still run the exact projection on the candidates. */
export function edgesNear(g: GraphState, x: number, y: number, r: number): StreetEdge[] {
  const grid = gridFor(g.edges);
  const x0 = Math.floor((x - r) / CELL);
  const x1 = Math.floor((x + r) / CELL);
  const y0 = Math.floor((y - r) / CELL);
  const y1 = Math.floor((y + r) / CELL);
  const ids = new Set<string>();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const set = grid.cells.get(cellKey(cx, cy));
      if (set) for (const id of set) ids.add(id);
    }
  }
  const out: StreetEdge[] = [];
  for (const id of ids) {
    const e = g.edges[id];
    if (e) out.push(e);
  }
  return out;
}
