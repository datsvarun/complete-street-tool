// Headless topology tests for mesh-core.js — run with: node test-mesh-core.js
const M = require('./mesh-core.js');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); failures++; }
};

const graph = M.seedNetwork();
const mesh = M.generateMesh(graph, M.DEFAULT_BANDS, 15);

console.log(`mesh: ${mesh.nodes.size} nodes, ${mesh.faces.length} faces`);

// 1. No NaN / missing coordinates
let bad = 0;
for (const [id, p] of mesh.nodes) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { bad++; console.log('   bad node', id, p); }
}
ok(bad === 0, 'all node coordinates finite');

// 2. Every face references existing nodes
let missing = 0;
for (const f of mesh.faces) for (const nid of f.nodes) if (!mesh.nodes.has(nid)) missing++;
ok(missing === 0, 'all face node refs resolve');

// 3. All faces have positive, sane area
let degenerate = [];
for (const f of mesh.faces) {
  const a = M.polygonArea(M.faceCoords(mesh, f));
  if (!(a > 0.5)) degenerate.push(`${f.id} area=${a.toFixed(3)}`);
}
ok(degenerate.length === 0, `all ${mesh.faces.length} faces have area > 0.5 m2` +
  (degenerate.length ? ' — ' + degenerate.slice(0, 5).join(', ') : ''));

// 4. Bend node M: mitred boundary nodes shared by strips of BOTH edges BM and MC
const adj = M.buildAdjacency(mesh);
const bendId = 'bend:M:2'; // a carriageway-edge boundary node at the bend
ok(mesh.nodes.has(bendId), 'bend node exists at M');
const bendFaces = (adj.get(bendId) || []).map(i => mesh.faces[i]);
const bendEdges = new Set(bendFaces.map(f => f.edge).filter(Boolean));
ok(bendEdges.has('BM') && bendEdges.has('MC'),
  `bend boundary node shared by strips of BM and MC (edges: ${[...bendEdges]})`);

// 5. Junction B: leg-end carriageway node shared by strip + junction face
const jctNodeIds = [...mesh.nodes.keys()].filter(id => id.startsWith('jct:B:'));
ok(jctNodeIds.length === 4 * 6, `junction B has 4 legs x 6 boundary nodes (got ${jctNodeIds.length})`);
const jctFace = mesh.faces.find(f => f.id === 'face:jct:B');
ok(!!jctFace && jctFace.nodes.length === 8, 'junction B carriageway face is an octagon (4 legs x 2)');
let jctShared = true;
for (const nid of jctFace.nodes) {
  const kinds = new Set((adj.get(nid) || []).map(i => mesh.faces[i].kind));
  if (!kinds.has('strip')) jctShared = false;
}
ok(jctShared, 'every junction-face node is also used by a leg strip');

// 6. Corner faces at B: share nodes with junction face AND with strips
const corners = mesh.faces.filter(f => f.kind === 'corner' && f.id.includes(':B:'));
ok(corners.length === 4 * 2, `junction B has 4 corners x 2 band levels (got ${corners.length})`);
const cornerLinked = corners.every(c => {
  const shared = c.nodes.filter(nid =>
    (adj.get(nid) || []).some(i => mesh.faces[i].kind === 'strip'));
  return shared.length === 4; // all 4 corner-quad nodes sit on leg ends
});
ok(cornerLinked, 'all corner-face nodes are shared with leg strips');

// 7. Skewed junction C (4 legs, non-perpendicular) sane too
const jctC = mesh.faces.find(f => f.id === 'face:jct:C');
ok(!!jctC && M.polygonArea(M.faceCoords(mesh, jctC)) > 20, 'skewed junction C face exists with sane area');

// 8. Simulate the headline interaction: move a shared node, verify every
//    adjacent face changes area while non-adjacent faces are untouched.
const target = 'jct:B:EB:2';
const before = mesh.faces.map(f => M.polygonArea(M.faceCoords(mesh, f)));
const p = mesh.nodes.get(target);
p.x += 4; p.y += 3;
const after = mesh.faces.map(f => M.polygonArea(M.faceCoords(mesh, f)));
const touched = adj.get(target);
const changed = [], leaked = [];
mesh.faces.forEach((f, i) => {
  const delta = Math.abs(after[i] - before[i]);
  if (touched.includes(i)) { if (delta > 1e-9) changed.push(i); }
  else if (delta > 1e-9) leaked.push(f.id);
});
ok(changed.length === touched.length && touched.length >= 3,
  `dragging ${target} reshaped all ${touched.length} faces sharing it (strip+junction+corner)`);
ok(leaked.length === 0, 'no unrelated face changed');
const touchedKinds = new Set(touched.map(i => mesh.faces[i].kind));
ok(touchedKinds.has('strip') && touchedKinds.has('junction'),
  `shared node drives multiple functions at once: ${[...touchedKinds].join(', ')}`);

// 9. Regeneration with different segment length still valid
const fine = M.generateMesh(M.seedNetwork(), M.DEFAULT_BANDS, 6);
ok(fine.faces.length > mesh.faces.length, `finer segLen -> more faces (${fine.faces.length} > ${mesh.faces.length})`);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
