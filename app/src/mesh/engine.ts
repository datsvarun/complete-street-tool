// Node-mesh engine (MESH_INTEGRATION_SPEC + Mesh_Architecture.md §0).
// The generated street design frozen into the spec's shared-node model:
//
//   mesh.nodes : Record<nodeId, {x, y}>          — every point exists ONCE
//   mesh.faces : [{ id, fn, kind, nodes: [id] }] — polygons reference ids
//
// u-axis = cross-section bands, v-axis = stations (centerline vertices), so
// each strip face is one band × one segment. Junction rings/wedges/noses are
// faces welded to the strips where they coincide. Every op below is pure:
// (mesh, args) → new mesh (or null when preconditions fail) — zundo gives
// undo, the store wraps each op in one set().
//
// Adaptation from the spec (deliberate): geometry comes from CST's generator
// (fillets/wedges/transitions), not the prototype's simpler junction builder.
import type { ComponentKind, GraphState, JunctionDesign } from '../types';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import type { CornerMode } from '../graph/junctions';
import { offsetPolyline, polylineLength, subPolyline, toPts } from '../geometry/polyline';
import { refFraction } from '../geometry/ribbon';

export type MeshFn = ComponentKind | 'junction' | 'island';

export interface MeshFace {
  id: string;
  fn: MeshFn;
  kind: 'strip' | 'junction' | 'jband' | 'transition' | 'island' | 'split';
  nodes: string[];
  edge?: string; // owning edge for strips (snapping/cut context)
}

export interface MeshNode {
  x: number;
  y: number;
  /** Mid-point of a three-point circular arc: the boundary from the previous
   *  to the next node of a face renders as the circle through all three. */
  arc?: boolean;
}

export interface Mesh {
  nodes: Record<string, MeshNode>;
  faces: MeshFace[];
  editLog: string[];
  nextNum: number; // inserted-node counter
}

const WELD = 0.02;
const key = (x: number, y: number) => `${Math.round(x / WELD)}:${Math.round(y / WELD)}`;

/** Collapse runs of short, consistently-turning sampled segments into
 *  three-point arcs (start · flagged mid · end) — the generator emits curves
 *  as dense polylines; the mesh should hold editable arcs, not node soup.
 *  Deterministic and orientation-independent (mid picked by arc length), so
 *  the two faces sharing a curve collapse it to the SAME three nodes. */
function arcify(poly: number[]): Array<{ x: number; y: number; arc?: boolean }> {
  const pts: Array<{ x: number; y: number; arc?: boolean }> = [];
  for (let i = 0; i + 1 < poly.length; i += 2) pts.push({ x: poly[i], y: poly[i + 1] });
  const n = pts.length;
  if (n < 5) return pts;
  const seg = (i: number) => ({ x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y });
  const turn: number[] = []; // signed turn at interior vertex i (rad)
  for (let i = 1; i < n - 1; i++) {
    const a = seg(i - 1);
    const b = seg(i);
    turn[i] = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  }
  const curvy = (i: number) => {
    const t = turn[i];
    if (t === undefined || Math.abs(t) < 0.015 || Math.abs(t) > 0.5) return 0;
    const l1 = Math.hypot(seg(i - 1).x, seg(i - 1).y);
    const l2 = Math.hypot(seg(i).x, seg(i).y);
    return l1 < 4 && l2 < 4 ? Math.sign(t) : 0;
  };
  const out: typeof pts = [pts[0]];
  let i = 1;
  while (i < n - 1) {
    const s = curvy(i);
    let j = i;
    while (j + 1 < n - 1 && curvy(j + 1) === s && s !== 0) j++;
    if (s !== 0 && j - i >= 2) {
      // arc-length midpoint of the run (ties broken by coordinates → both
      // traversal directions pick the same physical vertex)
      let len = 0;
      const cum = [0];
      for (let m = i; m < j; m++) {
        len += Math.hypot(pts[m + 1].x - pts[m].x, pts[m + 1].y - pts[m].y);
        cum.push(len);
      }
      let best = i;
      let bd = Infinity;
      for (let m = i; m <= j; m++) {
        const d = Math.abs(cum[m - i] - len / 2);
        const p = pts[m];
        const better = d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && (p.x < pts[best].x || (p.x === pts[best].x && p.y < pts[best].y)));
        if (better) {
          bd = d;
          best = m;
        }
      }
      out.push({ ...pts[best], arc: true });
      i = j + 1;
    } else {
      out.push(pts[i]);
      i++;
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/** Circumcircle through three points, or null when (near-)collinear. */
export function circleFrom3(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): { x: number; y: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

/** Face outline as flat coords with arc mids expanded into sampled circular
 *  arcs — for export/plotting; the canvas draws true arcs itself. */
export function facePoints(mesh: Mesh, f: MeshFace, arcSegs = 10): number[] {
  const ids = f.nodes.filter((id) => mesh.nodes[id]);
  const n = ids.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const cur = mesh.nodes[ids[i]];
    if (!cur.arc) {
      out.push(cur.x, cur.y);
      continue;
    }
    const A = mesh.nodes[ids[(i - 1 + n) % n]];
    const B = mesh.nodes[ids[(i + 1) % n]];
    const c = circleFrom3(A.x, A.y, cur.x, cur.y, B.x, B.y);
    if (!c) {
      out.push(cur.x, cur.y);
      continue;
    }
    const a0 = Math.atan2(A.y - c.y, A.x - c.x);
    const am = Math.atan2(cur.y - c.y, cur.x - c.x);
    const a1 = Math.atan2(B.y - c.y, B.x - c.x);
    // sweep from a0 to a1 passing through am
    let d1 = a1 - a0;
    let dm = am - a0;
    const TAU = 2 * Math.PI;
    d1 = ((d1 % TAU) + TAU) % TAU;
    dm = ((dm % TAU) + TAU) % TAU;
    const sweep = dm <= d1 ? d1 : d1 - TAU; // ccw if mid inside ccw span
    for (let s = 1; s < arcSegs; s++) {
      const a = a0 + (sweep * s) / arcSegs;
      out.push(c.x + c.r * Math.cos(a), c.y + c.r * Math.sin(a));
    }
  }
  return out;
}

/** Freeze the whole derived design into one shared-node mesh. */
export function buildMesh(
  g: GraphState,
  designs: Record<string, JunctionDesign>,
  corners: CornerMode,
): Mesh {
  const { junctions, transitions, trims } = deriveNodeArtifactsCached(g, designs, corners);
  const nodes: Mesh['nodes'] = {};
  const faces: MeshFace[] = [];
  const byPos = new Map<string, string>(); // weld hash → canonical node id

  const nodeAt = (id: string, x: number, y: number, arc?: boolean): string => {
    const k = key(x, y);
    const hit = byPos.get(k);
    if (hit) return hit;
    byPos.set(k, id);
    nodes[id] = arc ? { x, y, arc } : { x, y };
    return id;
  };

  // Edge strips: K+1 boundary polylines (same vertex count — offsets of one
  // base), quads per (station, band).
  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const comps = e.section.components;
    const total = comps.reduce((s, c) => s + c.widthM, 0);
    let off = total * refFraction(e.section);
    const offs = [off];
    for (const c of comps) offs.push((off -= c.widthM));
    const L = polylineLength(e.points);
    const t = trims[e.id];
    const base = toPts(subPolyline(e.points, t?.start ?? 0, L - (t?.end ?? 0)));
    if (base.length < 2) continue;
    // node grid [station][k]
    const grid: string[][] = [];
    for (let k2 = 0; k2 < offs.length; k2++) {
      const bpts = offsetPolyline(base, offs[k2]);
      bpts.forEach((p, si) => {
        (grid[si] ??= [])[k2] = nodeAt(`s:${e.id}:${si}:${k2}`, p.x, p.y);
      });
    }
    for (let si = 0; si + 1 < grid.length; si++) {
      for (let k2 = 0; k2 < comps.length; k2++) {
        faces.push({
          id: `f:${e.id}:${si}:${k2}`,
          fn: comps[k2].kind,
          kind: 'strip',
          edge: e.id,
          nodes: [grid[si][k2], grid[si][k2 + 1], grid[si + 1][k2 + 1], grid[si + 1][k2]],
        });
      }
    }
  }

  const addPoly = (id: string, fn: MeshFn, kind: MeshFace['kind'], poly: number[]) => {
    const ids: string[] = [];
    arcify(poly).forEach((p, i) => {
      ids.push(nodeAt(`${id}:${i}`, p.x, p.y, p.arc));
    });
    // drop consecutive duplicates from welding
    const loop = ids.filter((n, i) => n !== ids[(i + 1) % ids.length]);
    if (new Set(loop).size >= 3) faces.push({ id, fn, kind, nodes: loop });
  };

  for (const j of junctions) {
    addPoly(`fj:${j.key}`, 'junction', 'junction', j.polygon);
    j.coverBands.forEach((b, i) => addPoly(`fjc:${j.key}:${i}`, 'junction', 'junction', b));
    [...j.wedges, ...j.noses].forEach((b, i) => addPoly(`fw:${j.key}:${i}`, b.kind, 'jband', b.polygon));
  }
  for (const t of transitions) {
    t.bands.forEach((b, i) => addPoly(`ft:${t.nodeId}:${i}`, b.kind, 'transition', b.polygon));
  }

  return { nodes, faces, editLog: [], nextNum: 1 };
}

/* ── adjacency / helpers ─────────────────────────────────────────────── */

export function facesOfNode(mesh: Mesh, nid: string): MeshFace[] {
  return mesh.faces.filter((f) => f.nodes.includes(nid));
}

/** faces containing the consecutive pair (a,b) in either direction. */
export function facesOfSegment(mesh: Mesh, a: string, b: string): MeshFace[] {
  return mesh.faces.filter((f) => {
    const n = f.nodes;
    return n.some((id, i) => {
      const nx = n[(i + 1) % n.length];
      return (id === a && nx === b) || (id === b && nx === a);
    });
  });
}

const log = (mesh: Mesh, op: string): Mesh => ({ ...mesh, editLog: [...mesh.editLog, op] });

/* ── operations (pure; null = precondition failed) ───────────────────── */

/** `quiet` skips the edit log — for per-frame drag updates; log once on drop. */
export function moveNode(mesh: Mesh, nid: string, x: number, y: number, quiet = false): Mesh | null {
  if (!mesh.nodes[nid]) return null;
  const next = { ...mesh, nodes: { ...mesh.nodes, [nid]: { x, y } } };
  return quiet ? next : log(next, 'move');
}

/** Insert a node at (x,y) on the segment (a,b) of EVERY face containing it —
 *  splicing only one face would unzip the shared boundary (spec §5.2). */
export function insertOnSegment(mesh: Mesh, a: string, b: string, x: number, y: number): Mesh | null {
  const hit = facesOfSegment(mesh, a, b);
  if (hit.length === 0) return null;
  const nid = `ins:${mesh.nextNum}`;
  const faces = mesh.faces.map((f) => {
    if (!hit.includes(f)) return f;
    const n = f.nodes;
    const out: string[] = [];
    for (let i = 0; i < n.length; i++) {
      out.push(n[i]);
      const nx = n[(i + 1) % n.length];
      if ((n[i] === a && nx === b) || (n[i] === b && nx === a)) out.push(nid);
    }
    return { ...f, nodes: out };
  });
  return log(
    { ...mesh, nodes: { ...mesh.nodes, [nid]: { x, y } }, faces, nextNum: mesh.nextNum + 1 },
    'insert-node',
  );
}

export function retypeFace(mesh: Mesh, faceId: string, fn: MeshFn): Mesh | null {
  const f = mesh.faces.find((x) => x.id === faceId);
  if (!f || f.fn === fn) return null;
  return log({ ...mesh, faces: mesh.faces.map((x) => (x === f ? { ...x, fn } : x)) }, 'retype');
}

/** Longest shared chain (consecutive in both loops) between two faces. */
function sharedChain(a: MeshFace, b: MeshFace): string[] {
  const bs = new Set(b.nodes);
  const n = a.nodes;
  let best: string[] = [];
  for (let i = 0; i < n.length; i++) {
    if (!bs.has(n[i])) continue;
    const run = [n[i]];
    for (let j = 1; j < n.length; j++) {
      const nx = n[(i + j) % n.length];
      if (bs.has(nx)) run.push(nx);
      else break;
    }
    if (run.length > best.length) best = run;
  }
  return best;
}

/** Merge two faces sharing a chain of ≥2 nodes (spec §5.5; also powers
 *  delete-with-absorb §5.4b). Keeps `a`'s fn. */
export function mergeFaces(mesh: Mesh, aId: string, bId: string): Mesh | null {
  const A = mesh.faces.find((f) => f.id === aId);
  const B = mesh.faces.find((f) => f.id === bId);
  if (!A || !B || A === B) return null;
  const chain = sharedChain(A, B);
  if (chain.length < 2) return null;
  const first = chain[0];
  const last = chain[chain.length - 1];
  // walk A from chain END around to chain START (excluding interior), then B
  // from chain START around to chain END — orientations of generated faces
  // may differ, so pick B's direction that avoids re-entering the chain.
  // rotate loop to start at `from`, then take elements until `to` in
  // whichever direction doesn't pass through the chain interior.
  const path = (loop: string[], from: string, to: string, avoid: Set<string>): string[] | null => {
    const i0 = loop.indexOf(from);
    if (i0 < 0) return null;
    for (const dir of [1, -1] as const) {
      const out = [from];
      for (let s = 1; s <= loop.length; s++) {
        const id = loop[(i0 + dir * s + loop.length * 2) % loop.length];
        if (id === to) {
          out.push(to);
          return out;
        }
        if (avoid.has(id)) break;
        out.push(id);
      }
    }
    return null;
  };
  const interior = new Set(chain.slice(1, -1));
  const pa = path(A.nodes, last, first, interior);
  const pb = path(B.nodes, first, last, interior);
  if (!pa || !pb) return null;
  const loop = [...pa.slice(0, -1), ...pb.slice(0, -1)];
  if (new Set(loop).size < 3) return null;
  // interior chain nodes referenced by no other face are deleted
  const others = mesh.faces.filter((f) => f !== A && f !== B);
  const nodes = { ...mesh.nodes };
  for (const nid of interior) {
    if (!others.some((f) => f.nodes.includes(nid))) delete nodes[nid];
  }
  const merged: MeshFace = { ...A, nodes: loop.filter((nid) => nodes[nid]) };
  return log({ ...mesh, nodes, faces: [...others, merged] }, 'merge');
}

/** Delete = absorb into the neighbour with the longest shared chain,
 *  preferring drivable absorbers (spec §5.4b). */
export function deleteFaceAbsorb(mesh: Mesh, faceId: string): Mesh | null {
  const F = mesh.faces.find((f) => f.id === faceId);
  if (!F) return null;
  let best: { f: MeshFace; len: number } | null = null;
  for (const f of mesh.faces) {
    if (f === F) continue;
    const len = sharedChain(f, F).length;
    if (len < 2) continue;
    const pref = (x: MeshFace) => (x.fn === 'carriageway' || x.fn === 'junction' ? 1000 : 0);
    const score = len + pref(f);
    if (!best || score > best.len) best = { f, len: score };
  }
  if (!best) {
    // isolated face: plain removal
    const others = mesh.faces.filter((f) => f !== F);
    const nodes = { ...mesh.nodes };
    for (const nid of F.nodes) if (!others.some((f) => f.nodes.includes(nid))) delete nodes[nid];
    return log({ ...mesh, nodes, faces: others }, 'delete');
  }
  return mergeFaces(mesh, best.f.id, faceId);
}

/** Split a face along the chord between two of its nodes (spec §5.5). */
export function splitFace(mesh: Mesh, faceId: string, na: string, nb: string): Mesh | null {
  const F = mesh.faces.find((f) => f.id === faceId);
  if (!F) return null;
  const ia = F.nodes.indexOf(na);
  const ib = F.nodes.indexOf(nb);
  if (ia < 0 || ib < 0 || ia === ib) return null;
  const n = F.nodes.length;
  const loopA: string[] = [];
  for (let i = ia; ; i = (i + 1) % n) {
    loopA.push(F.nodes[i]);
    if (i === ib) break;
  }
  const loopB: string[] = [];
  for (let i = ib; ; i = (i + 1) % n) {
    loopB.push(F.nodes[i]);
    if (i === ia) break;
  }
  if (new Set(loopA).size < 3 || new Set(loopB).size < 3) return null;
  const others = mesh.faces.filter((f) => f !== F);
  return log(
    {
      ...mesh,
      faces: [
        ...others,
        { ...F, id: `${F.id}.a`, kind: 'split', nodes: loopA },
        { ...F, id: `${F.id}.b`, kind: 'split', nodes: loopB },
      ],
    },
    'split',
  );
}

/** Weld dragged node onto target: every reference rewrites, slivers drop (spec §5.3). */
export function weldNodes(mesh: Mesh, drag: string, target: string): Mesh | null {
  if (drag === target || !mesh.nodes[drag] || !mesh.nodes[target]) return null;
  const faces: MeshFace[] = [];
  for (const f of mesh.faces) {
    if (!f.nodes.includes(drag)) {
      faces.push(f);
      continue;
    }
    const mapped = f.nodes.map((id) => (id === drag ? target : id));
    const loop = mapped.filter((id, i) => id !== mapped[(i + 1) % mapped.length]);
    if (new Set(loop).size >= 3) faces.push({ ...f, nodes: loop });
    // else: sliver face removed (taper pinched to zero)
  }
  const nodes = { ...mesh.nodes };
  delete nodes[drag];
  return log({ ...mesh, nodes, faces }, 'weld');
}

/** Street-wide cut: insert a full station row across every band of the strip
 *  column at `t` (0..1 within the column) — the v-axis split the user asked
 *  for. Returns the new mesh or null. */
export function cutAcross(mesh: Mesh, edgeId: string, si: number, t: number): Mesh | null {
  const col = mesh.faces.filter(
    (f) => f.kind === 'strip' && f.edge === edgeId && f.id.startsWith(`f:${edgeId}:${si}:`),
  );
  if (col.length === 0) return null;
  // boundary rows: face nodes are [a_k, a_k1, b_k1, b_k] — collect a/b rows
  const nodes = { ...mesh.nodes };
  let num = mesh.nextNum;
  const midOf = new Map<string, string>(); // `${aId}|${bId}` → mid node
  const midFor = (aId: string, bId: string): string => {
    const mk = `${aId}|${bId}`;
    const hit = midOf.get(mk);
    if (hit) return hit;
    const A = nodes[aId];
    const B = nodes[bId];
    const id = `ins:${num++}`;
    nodes[id] = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
    midOf.set(mk, id);
    return id;
  };
  const faces: MeshFace[] = [];
  for (const f of mesh.faces) {
    if (!col.includes(f) || f.nodes.length !== 4) {
      faces.push(f);
      continue;
    }
    const [ak, ak1, bk1, bk] = f.nodes;
    const mk = midFor(ak, bk);
    const mk1 = midFor(ak1, bk1);
    faces.push(
      { ...f, id: `${f.id}.a`, nodes: [ak, ak1, mk1, mk] },
      { ...f, id: `${f.id}.b`, nodes: [mk, mk1, bk1, bk] },
    );
  }
  return log({ ...mesh, nodes, faces, nextNum: num }, 'cut-across');
}

/** Fillet a corner node: tangent points + arc spliced into every face using
 *  this corner via the same two segments (spec §5.6, no registry in v1). */
export function filletNode(mesh: Mesh, nid: string, r: number): Mesh | null {
  const P = mesh.nodes[nid];
  const hit = facesOfNode(mesh, nid);
  if (!P || hit.length === 0) return null;
  // corner geometry from the first face's neighbours
  const f0 = hit[0];
  const i = f0.nodes.indexOf(nid);
  const prev = f0.nodes[(i - 1 + f0.nodes.length) % f0.nodes.length];
  const next = f0.nodes[(i + 1) % f0.nodes.length];
  const A = mesh.nodes[prev];
  const B = mesh.nodes[next];
  const v1 = { x: A.x - P.x, y: A.y - P.y };
  const v2 = { x: B.x - P.x, y: B.y - P.y };
  const l1 = Math.hypot(v1.x, v1.y);
  const l2 = Math.hypot(v2.x, v2.y);
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  const ang = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2))));
  if (ang > Math.PI - 0.15 || ang < 0.15) return null; // ~straight: nothing to fillet
  const tan = Math.min(r / Math.tan(ang / 2), l1 * 0.45, l2 * 0.45);
  const t1 = { x: P.x + (v1.x / l1) * tan, y: P.y + (v1.y / l1) * tan };
  const t2 = { x: P.x + (v2.x / l2) * tan, y: P.y + (v2.y / l2) * tan };
  const nodes = { ...mesh.nodes };
  let num = mesh.nextNum;
  // three-point arc: tangent points + flagged mid (bezier apex at u = 0.5)
  const arcIds: string[] = [];
  for (const [px, py, arc] of [
    [t1.x, t1.y, false],
    [0.25 * t1.x + 0.5 * P.x + 0.25 * t2.x, 0.25 * t1.y + 0.5 * P.y + 0.25 * t2.y, true],
    [t2.x, t2.y, false],
  ] as Array<[number, number, boolean]>) {
    const id = `ins:${num++}`;
    nodes[id] = arc ? { x: px, y: py, arc } : { x: px, y: py };
    arcIds.push(id);
  }
  let used = false;
  const faces = mesh.faces.map((f) => {
    const j = f.nodes.indexOf(nid);
    if (j < 0) return f;
    const p = f.nodes[(j - 1 + f.nodes.length) % f.nodes.length];
    const nx = f.nodes[(j + 1) % f.nodes.length];
    // splice only where the corner is formed by the SAME two segments
    if (!((p === prev && nx === next) || (p === next && nx === prev))) return f;
    used = true;
    const arc = p === prev ? arcIds : [...arcIds].reverse();
    return { ...f, nodes: [...f.nodes.slice(0, j), ...arc, ...f.nodes.slice(j + 1)] };
  });
  if (!used) return null;
  // corner node kept only if still referenced elsewhere
  if (!faces.some((f) => f.nodes.includes(nid))) delete nodes[nid];
  return log({ ...mesh, nodes, faces, nextNum: num }, 'fillet');
}

/* ── invariants (spec §6, dev/test) ──────────────────────────────────── */

export function meshInvariants(mesh: Mesh): string[] {
  const errs: string[] = [];
  for (const f of mesh.faces) {
    if (new Set(f.nodes).size < 3) errs.push(`${f.id}: <3 distinct nodes`);
    for (const nid of f.nodes) {
      const p = mesh.nodes[nid];
      if (!p) errs.push(`${f.id}: missing node ${nid}`);
      else if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) errs.push(`${nid}: NaN`);
    }
  }
  return errs;
}
