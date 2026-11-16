/*
 * mesh-core.js — pure topology/geometry engine for the node-mesh street system.
 *
 * Concept: after the centerline network is fixed, the whole street is generated
 * as a single shared mesh:
 *
 *   mesh.nodes : Map<nodeId, {x, y}>          — every point exists exactly ONCE
 *   mesh.faces : [{ id, fn, kind, nodes: [nodeId, ...] }]
 *
 * Faces never store coordinates — only node ids. Abutting faces (footpath next
 * to cycle track, strip meeting a junction, two legs meeting at a bend) reference
 * the SAME node ids along their common boundary. Moving one node therefore
 * reshapes every face that touches it, automatically.
 *
 * No DOM, no dependencies. Loadable in the browser (window.MeshCore) or Node
 * (module.exports) so the generation logic can be unit-tested headlessly and
 * later ported into complete-street-tool/src/geo/.
 *
 * Units: metres, screen-style coordinates (y grows downward).
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- vectors */
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const vlen = (a) => Math.hypot(a.x, a.y);
  const norm = (a) => { const l = vlen(a) || 1; return { x: a.x / l, y: a.y / l }; };
  // Perpendicular (rotate +90°). With y-down coordinates this is the consistent
  // "offset side" used everywhere below; only consistency matters.
  const perp = (a) => ({ x: -a.y, y: a.x });

  /* ---------------------------------------------- cross-section definition */
  // Simplified IRC-style cross-section: an ordered list of bands, left→right
  // across the street. Mirrors complete-street-tool's `components` array.
  const DEFAULT_BANDS = [
    { fn: 'footpath',    w: 3.0 },
    { fn: 'cycletrack',  w: 2.0 },
    { fn: 'carriageway', w: 7.0 },
    { fn: 'cycletrack',  w: 2.0 },
    { fn: 'footpath',    w: 3.0 },
  ];

  // Signed offsets of the K+1 band boundaries from the centerline.
  function boundaryOffsets(bands) {
    const total = bands.reduce((s, b) => s + b.w, 0);
    const offs = [-total / 2];
    for (const b of bands) offs.push(offs[offs.length - 1] + b.w);
    return offs;
  }

  /* ------------------------------------------------------- demo centerline */
  // Seed network: one 4-way perpendicular crossing (B), one skewed crossing (C)
  // and a bend (M) on the main road — the three cases from the concept sketch.
  function seedNetwork() {
    return {
      nodes: {
        A: { x:  40, y: 220 },
        B: { x: 230, y: 220 },
        M: { x: 330, y: 255 },
        C: { x: 430, y: 250 },
        D: { x: 620, y: 250 },
        E: { x: 230, y:  60 },
        F: { x: 230, y: 400 },
        G: { x: 320, y: 420 },
        H: { x: 560, y:  80 },
      },
      edges: [
        { id: 'AB', a: 'A', b: 'B' },
        { id: 'BM', a: 'B', b: 'M' },
        { id: 'MC', a: 'M', b: 'C' },
        { id: 'CD', a: 'C', b: 'D' },
        { id: 'EB', a: 'E', b: 'B' },
        { id: 'BF', a: 'B', b: 'F' },
        { id: 'GC', a: 'G', b: 'C' },
        { id: 'CH', a: 'C', b: 'H' },
      ],
    };
  }

  /* --------------------------------------------------------- mesh builder */
  /**
   * generateMesh(graph, bands, segLen)
   *
   * graph  : { nodes: {id:{x,y}}, edges: [{id, a, b}] } — same shape as the
   *          `network` state in complete-street-tool's App.jsx.
   * bands  : cross-section bands (assumed symmetric, one carriageway band).
   * segLen : target longitudinal subdivision in metres (the cross ties in the
   *          concept sketch). Smaller = finer editing granularity.
   *
   * Returns { nodes: Map, faces: [], offs: [] }.
   *
   * Node-sharing strategy (this is the whole point):
   *  - degree-1 graph node → squared end cap, nodes owned by the edge end.
   *  - degree-2 graph node → ONE mitred set of boundary nodes shared by both
   *    incident edges' strips.
   *  - degree-3+ graph node → each leg is trimmed back; its end boundary nodes
   *    are shared between the leg's strip faces, the junction carriageway face
   *    AND the corner faces that wrap footpath/cycle bands around the corner.
   */
  function generateMesh(graph, bands, segLen) {
    bands = bands || DEFAULT_BANDS;
    segLen = segLen || 15;

    const offs = boundaryOffsets(bands);
    const K = offs.length - 1;                       // number of bands
    const total = offs[K] - offs[0];
    const carIdx = bands.findIndex((b) => b.fn === 'carriageway');
    const beyond = K - 1 - carIdx;                   // bands outside carriageway, per side

    const nodes = new Map();
    const faces = [];
    const addNode = (id, x, y) => { if (!nodes.has(id)) nodes.set(id, { x, y }); return id; };

    const P = (nid) => graph.nodes[nid];
    const other = (e, nid) => (e.a === nid ? e.b : e.a);

    const incident = {};
    for (const e of graph.edges) {
      (incident[e.a] = incident[e.a] || []).push(e);
      (incident[e.b] = incident[e.b] || []).push(e);
    }

    // endInfo[edgeId][graphNodeId] = { trim, ids }
    // `ids[k]` = mesh node id for the edge's k-th boundary at that end,
    // indexed in the EDGE's own left→right frame (a→b travel direction).
    const endInfo = {};
    for (const e of graph.edges) endInfo[e.id] = {};

    for (const nid in graph.nodes) {
      const inc = incident[nid] || [];
      const N = P(nid);
      if (inc.length === 0) continue;

      if (inc.length === 1) {
        /* ---- dead end: squared cap, perpendicular to the edge ---- */
        const e = inc[0];
        const d = norm(sub(P(e.b), P(e.a)));         // edge travel direction
        const n = perp(d);
        const ids = [];
        for (let k = 0; k <= K; k++) {
          ids.push(addNode(`cap:${nid}:${k}`, N.x + n.x * offs[k], N.y + n.y * offs[k]));
        }
        endInfo[e.id][nid] = { trim: 0, ids };

      } else if (inc.length === 2) {
        /* ---- bend: one mitred boundary set SHARED by both edges ---- */
        const [e, f] = inc;
        const t1 = norm(sub(N, P(other(e, nid))));   // travel INTO the bend along e
        const t2 = norm(sub(P(other(f, nid)), N));   // travel OUT of the bend along f
        const n1 = perp(t1), n2 = perp(t2);
        let m = add(n1, n2);
        const L = vlen(m);
        let scale;
        if (L < 1e-9) { m = n1; scale = 1; }         // degenerate U-turn
        else { m = mul(m, 1 / L); scale = 1 / Math.max(0.25, dot(m, n1)); } // miter, clamped 4x

        const frame = [];                            // index kk in the through-travel frame
        for (let kk = 0; kk <= K; kk++) {
          frame.push(addNode(`bend:${nid}:${kk}`, N.x + m.x * offs[kk] * scale, N.y + m.y * offs[kk] * scale));
        }
        // Map each edge's own boundary index k onto the shared frame. If the
        // edge is stored opposite to the through-travel direction, its
        // left/right flips: k ↔ K-k.
        const mapIds = (aligned) => frame.map((_, k) => frame[aligned ? k : K - k]);
        endInfo[e.id][nid] = { trim: 0, ids: mapIds(e.b === nid) };
        endInfo[f.id][nid] = { trim: 0, ids: mapIds(f.a === nid) };

      } else {
        /* ---- junction: trim legs, weave junction + corner faces ---- */
        const legs = inc.map((e) => {
          const toOther = sub(P(other(e, nid)), N);
          const elen = vlen(toOther);
          return {
            e,
            o: norm(toOther),                        // outward direction of the leg
            elen,
            ang: Math.atan2(toOther.y, toOther.x),
          };
        }).sort((p, q) => p.ang - q.ang);

        // Angle-aware setback: each leg retreats far enough that the corner
        // quads to BOTH its angular neighbours stay proper. Two legs meeting
        // at angle θ have overlapping offset bands out to (total/2)/tan(θ/2)
        // from the node; add a margin so the corner keeps visible depth.
        const cornerNeed = (dAng) => {
          const t = Math.tan(Math.min(dAng, Math.PI * 0.999) / 2);
          return t < 1e-6 ? total * 2.5 : (total / 2) / t;
        };
        for (let i = 0; i < legs.length; i++) {
          const prev = legs[(i + legs.length - 1) % legs.length];
          const next = legs[(i + 1) % legs.length];
          const gapNext = ((next.ang - legs[i].ang) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
          const gapPrev = ((legs[i].ang - prev.ang) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
          const need = Math.max(total * 0.6, cornerNeed(gapNext), cornerNeed(gapPrev)) + total * 0.35;
          legs[i].trim = Math.min(need, total * 2.5, legs[i].elen * 0.45);
        }

        for (const leg of legs) {
          const E = { x: N.x + leg.o.x * leg.trim, y: N.y + leg.o.y * leg.trim };
          const pl = perp(leg.o);
          leg.local = [];                            // kk in the leg's OUTWARD frame
          for (let kk = 0; kk <= K; kk++) {
            leg.local.push(addNode(`jct:${nid}:${leg.e.id}:${kk}`, E.x + pl.x * offs[kk], E.y + pl.y * offs[kk]));
          }
          const aligned = leg.e.a === nid;           // edge travels outward from N
          endInfo[leg.e.id][nid] = {
            trim: leg.trim,
            ids: leg.local.map((_, k) => leg.local[aligned ? k : K - k]),
          };
        }

        // Junction carriageway face: walks every leg's two carriageway-edge
        // nodes in angular order. Those nodes are the SAME nodes the legs'
        // strips end on.
        const poly = [];
        for (const leg of legs) poly.push(leg.local[carIdx], leg.local[carIdx + 1]);
        faces.push({ id: `face:jct:${nid}`, fn: 'junction', kind: 'junction', nodes: poly });

        // Corner faces: wrap each non-carriageway band around the corner
        // between angularly-adjacent legs (footpath corners, cycle corners).
        for (let i = 0; i < legs.length; i++) {
          const gi = legs[i];
          const gj = legs[(i + 1) % legs.length];
          for (let lvl = 0; lvl < beyond; lvl++) {
            faces.push({
              id: `face:corner:${nid}:${i}:${lvl}`,
              fn: bands[carIdx + 1 + lvl].fn,
              kind: 'corner',
              nodes: [
                gi.local[carIdx + 1 + lvl],          // inner, leg i (high-offset side)
                gi.local[carIdx + 2 + lvl],          // outer, leg i
                gj.local[carIdx - 1 - lvl],          // outer, leg i+1 (low-offset side)
                gj.local[carIdx - lvl],              // inner, leg i+1
              ],
            });
          }
        }
      }
    }

    /* ---- edge strips: quads between longitudinal stations ---- */
    for (const e of graph.edges) {
      const A = P(e.a), B = P(e.b);
      const d = norm(sub(B, A)), n = perp(d), elen = vlen(sub(B, A));
      const infoA = endInfo[e.id][e.a], infoB = endInfo[e.id][e.b];
      const t0 = infoA.trim, t1 = elen - infoB.trim;
      const span = Math.max(t1 - t0, 0.1);
      const nSeg = Math.max(1, Math.round(span / segLen));

      const stations = [infoA.ids];
      for (let s = 1; s < nSeg; s++) {
        const t = t0 + (span * s) / nSeg;
        const ids = [];
        for (let k = 0; k <= K; k++) {
          ids.push(addNode(`st:${e.id}:${s}:${k}`,
            A.x + d.x * t + n.x * offs[k],
            A.y + d.y * t + n.y * offs[k]));
        }
        stations.push(ids);
      }
      stations.push(infoB.ids);

      for (let s = 0; s < stations.length - 1; s++) {
        const s0 = stations[s], s1 = stations[s + 1];
        for (let bi = 0; bi < K; bi++) {
          faces.push({
            id: `face:${e.id}:${s}:${bi}`,
            fn: bands[bi].fn,
            kind: 'strip',
            edge: e.id,
            nodes: [s0[bi], s0[bi + 1], s1[bi + 1], s1[bi]],
          });
        }
      }
    }

    return { nodes, faces, offs };
  }

  /* --------------------------------------------------------- geometry utils */
  function faceCoords(mesh, face) {
    return face.nodes.map((id) => mesh.nodes.get(id));
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function pointInPolygon(pt, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i], pj = pts[j];
      if ((pi.y > pt.y) !== (pj.y > pt.y) &&
          pt.x < ((pj.x - pi.x) * (pt.y - pi.y)) / (pj.y - pi.y) + pi.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  // nodeId -> [face indices] — used by the UI to highlight everything a node drives.
  function buildAdjacency(mesh) {
    const adj = new Map();
    mesh.faces.forEach((f, i) => {
      for (const nid of f.nodes) {
        if (!adj.has(nid)) adj.set(nid, []);
        adj.get(nid).push(i);
      }
    });
    return adj;
  }

  const MeshCore = {
    DEFAULT_BANDS,
    boundaryOffsets,
    seedNetwork,
    generateMesh,
    faceCoords,
    polygonArea,
    pointInPolygon,
    buildAdjacency,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MeshCore;
  else global.MeshCore = MeshCore;
})(typeof window !== 'undefined' ? window : this);
