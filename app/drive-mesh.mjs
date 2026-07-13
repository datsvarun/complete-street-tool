// Headless verification drive: load the Pune sample, enter the edit stage,
// displace one welded mesh node shared between an edge band and a junction,
// and screenshot before/after. Run: node drive-mesh.mjs <outDir>
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '.';
const url = 'http://localhost:5199/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});

await page.goto(url);
await page.waitForFunction(() => window.__cst);
await page.evaluate(() => window.__cst.getState().clearAll());
await page.evaluate(() => window.__cst.getState().setBasemap('none')); // no tile noise headless
await page.evaluate(() => window.__cst.getState().loadSample());
await page.waitForFunction(
  () => !window.__cst.getState().importBusy && Object.keys(window.__cst.getState().edges).length > 0,
  null,
  { timeout: 30000 },
);
// sections stage auto-assigns IRC sections; then enter edit
await page.evaluate(() => window.__cst.getState().setStage('sections'));
await page.waitForTimeout(1000);
await page.evaluate(() => window.__cst.getState().setStage('edit'));
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/1-edit-stage.png` });

// Derive the mesh in-page and pick a node welded between an edge band and a junction.
const info = await page.evaluate(async () => {
  const st = window.__cst.getState();
  const mod = await import('/src/mesh/meshGeometry.ts');
  const view = mod.deriveMeshView(
    { nodes: st.nodes, edges: st.edges, nextNodeNum: 0, nextEdgeNum: 0 },
    st.junctionDesigns,
    st.settings.junctionBlend,
    st.vertexOverrides,
    st.meshEdits,
  );
  const m = view.mesh;
  let pick = -1;
  for (let i = 0; i < m.xs.length; i++) {
    const shapes = new Set(m.nodeFaces[i].map((f) => m.faces[f].shapeKey));
    const arr = [...shapes];
    if (arr.some((s) => s.startsWith('band:')) && arr.some((s) => s.startsWith('jring:') || s.startsWith('jband:'))) {
      pick = i;
      break;
    }
  }
  return {
    nodes: m.xs.length,
    faces: m.faces.length,
    sharedNodes: m.sharedNodeCount,
    pickKey: pick >= 0 ? m.nodeKeys[pick] : null,
    x: pick >= 0 ? m.xs[pick] : 0,
    y: pick >= 0 ? m.ys[pick] : 0,
    memberShapes: pick >= 0 ? [...new Set(m.nodeFaces[pick].map((f) => m.faces[f].shapeKey))] : [],
  };
});
console.log('MESH:', JSON.stringify(info, null, 1));
if (!info.pickKey) {
  console.log('FAIL: no band↔junction welded node found');
  await browser.close();
  process.exit(1);
}

// Zoom onto that node and screenshot before/after a 4m,3m displacement.
await page.evaluate(({ x, y }) => {
  window.__cst.setState({ pendingFit: { minX: x - 35, minY: y - 35, maxX: x + 35, maxY: y + 35 } });
}, info);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/2-before-drag.png` });

await page.evaluate((k) => window.__cst.getState().setMeshDelta(k, 4, 3), info.pickKey);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/3-after-drag.png` });

// Confirm the edit is in the undoable/persisted slice and survives undo/redo.
const roundtrip = await page.evaluate(() => {
  const st = window.__cst.getState();
  const before = JSON.stringify(st.meshEdits);
  st.undo();
  const afterUndo = JSON.stringify(window.__cst.getState().meshEdits);
  st.redo();
  const afterRedo = JSON.stringify(window.__cst.getState().meshEdits);
  return { before, afterUndo, afterRedo };
});
console.log('UNDO/REDO:', JSON.stringify(roundtrip, null, 1));

await browser.close();
console.log('DRIVE COMPLETE');
