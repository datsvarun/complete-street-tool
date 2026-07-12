# CST — Roadmap & Work Plan

**Audience:** the next engineer/agent. This is the single source of "what's
done, what's next, and in what order." Pair it with `ARCHITECTURE.md` (how the
system is built) and `CAD_Architecture.md` (the node-editing design).

**Working rules (from `CLAUDE.md`):** app code in `/app`; docs at root; all
geometry in the local metric CRS (lat/lon only at the map boundary); one
phase-slice per session, stop at the done-when and report. Every engine bug
fix ships with a vitest regression (`npm test`). Every interactive change is
driven end-to-end with Playwright before commit. Deploy = `npm run
deploy:pages` then push (GitHub Pages, deploy-from-branch).

---

## 1. Status at a glance

| stage / system | state |
|---|---|
| 1 · Network (draw, import, clean, DC merge) | **shipped** |
| 2 · Sections (IRC catalog, strip editor, transitions, multi-apply) | **shipped** |
| 2A · Junctions J1–J4 (fillets, wedges/noses, design handles, movements) | **shipped** |
| 3 · Detailing (furniture, markings, crossings, lane dividers, suggest) | **shipped** |
| 3.5 · Edit (free-form material patches + cuts, vertex editing) | **shipped** |
| 4 · Export (scaled SVG plan, print-to-PDF, extent crop) | **shipped** |
| Floating map-app UI, top toolbar (grouped + Delete tool), Direct tool, marquee/lasso | **shipped** |
| Bbox OSM import + filters (flyovers/service/paths) + bus-stop layer, export extent | **shipped** |
| **Persistence** (save/open `.cst.json`, autosave/restore) | **shipped** |
| Plot/ROW **boundary tracing** (network stage, persisted, exported) | **shipped** |
| Detailing auto-generate (zebras @ approaches, bus stops from OSM, lane counts) | **shipped** |
| Junction form Regular/Roundabout/Custom + roundabout preview geometry | **shipped** |
| **CAD P1** spatial index + unified snapping | **shipped** |
| **CAD P3–P5** keyed-vertex overrides, Edit-stage node editing of generated geometry | **shipped** |
| vitest engine suite (35 tests) | **shipped** |
| Canvas performance layer (LOD, viewport culling, imperative pointer path) | **shipped** — ARCHITECTURE §8 |
| UI maturity: status toast, shortcut help (?), mobile (touch pinch/tap, bottom-sheet panels) | **shipped** |
| **3D scaffold**: `scene3d/buildScene` spec + lazy three.js viewer (header "3D") | **shipped** — extrusions/kerbs/trees/lights |
| CAD P2 generic `<HandleLayer>` refactor | **not started** — next structural cleanup |
| Junctions J5–J7 (signal/priority templates, full roundabout, probe/validation) | **not started** |
| Detailing depth (element properties, signs, signals) | **partial** |

The app is a coherent end-to-end pipeline with save/open and CAD node-level
editing of every generated surface (see `CAD_Architecture.md` status header
for what shipped vs. the original sketch).

---

## 2. Prioritized work (each item is one shippable slice)

Ordered by leverage. Do them top-down unless a specific need reorders them.

### ~~P0 — Persistence MVP~~ ✅ shipped
`persistence.ts` + store `loadDocument`/`clearAll` + header Save/Open/New +
debounced autosave/restore. Document now also carries boundaries and
vertexOverrides.

### ~~P1 — CAD foundation: spatial index + unified snapping~~ ✅ shipped
`geometry/spatialIndex.ts` (uniform grid, memoized per edges identity);
`findSnap` (now also snaps interior vertices), `resolveDrop`, and node-drag
snapping all query local candidates.

### P2 — CAD: generic handle layer  *(pure refactor, big payoff)*
`CAD_Architecture.md` §5. Collapse the — now six — bespoke drag handlers
(`NodesLayer`, `VerticesLayer`, `JunctionHandlesLayer`, `PatchesLayer`
vertices, `ElementShape`, `ShapeEditLayer`) into one `<HandleLayer>` +
`useHandleDrag`.
- **Done-when:** no behaviour change; existing Playwright drives still green;
  the `setAttr('dragFrom')` debt (ARCHITECTURE §11.7) is gone.

### ~~P3 — CAD: keyed-vertex overrides~~ ✅ shipped (perimeter-fraction variant)
`cad/vertexOverrides.ts` + `vertexOverrides` store slice + Edit-stage shape
selection/vertex handles + export integration. Stale keys skip silently; the
Edit panel lists edited shapes with per-shape reset (there is no automatic
`pruneVertexOverrides` sweep yet — overrides whose shape vanished linger
harmlessly in the document until reset).

### P4 — Junctions J5: priority + signalized templates
`Junction_Tool_Design.md` §5, consumes the J4 movement graph.
- Zebra crossings (setback + ramps), stop lines, refuges where crossing >12 m,
  signal-head markers, right-turn pockets **as sectionOverrides**, greedy
  conflict-graph phase plan.
- **Done-when (Plan v2 §8 Phase 3):** one real 5-way junction, template +
  manual tweaks, legible.

### P5 — Detailing depth
Element property panel (rotation, spacing, per-instance width), signs &
signals as element kinds, richer bus-stop/driveway interaction with footpaths.

### P6 — Junctions J6 (roundabout) & J7 (probe boundaries + validation)
Roundabout template (island, circulatory, splitters, deflection check);
LaneMaker probe method for 5+/shallow corners; validation warnings surfaced
like the review list.

### P7 — Export & measurement polish
GeoJSON export; dimension/measurement annotations on the snapping service;
multi-sheet / paper-size presets; north arrow + legend refinements.

### P8 — 3D depth (on the shipped scaffold)
`scene3d/buildScene.ts` is the contract: pure design → `SceneSpec` (prisms +
posts), consumed by the lazy three.js viewer. Next increments, in order:
building massing from OSM (`building` footprints × height tags), remaining
element kinds (bus shelters, signals, bollards), textures/road markings in 3D,
an eye-level walkthrough camera, and glTF export straight from the SceneSpec.
Mobile note: right-click affordances (remove node/element) have no touch
equivalent yet — needs a long-press or explicit delete-mode pass.

---

## 3. Known debt & watch-list (carry forward)

From `ARCHITECTURE.md` §11 and the standing reviews:
- Three component-offset math variants (`buildApproach`,
  `componentSpan`/`drivableSpan`, `buildRibbon`) — unify carefully; reversal /
  no-drivable fallback semantics differ.
- `commitDraft` internal splits drop elements via pruning rather than
  re-anchoring (rare path; re-anchor when P3 lands).
- No spatial index yet (addressed by P1).
- Junction-handle drags stash baseline on Konva nodes via `setAttr('dragFrom')`
  (removed by P2).
- `refM` re-anchoring shifts the street sideways when left-of-reference
  components resize (deliberate; revisit if it bites).
- Wedge apron / `MIN_WEDGE_ANGLE` is a heuristic; the principled fix for
  shallow corners is the P6 probe method.
- 'cut' patches erase to the plan ground colour, not through to the basemap
  (Konva composites per-layer).

*(Stability sweep findings from this session are folded into §4.)*

## 4. Stability findings (this session)

A focused sweep of the just-landed Edit stage, Direct tool, box-draw, and
bbox import/export-extent found a cluster of **transient-state hygiene** bugs —
all **fixed** in the accompanying commit, root-caused rather than patched:

- **[high] Stale export/import extent survived re-import** — an old export crop
  clipped a freshly imported network to a rectangle that no longer overlapped
  it → silently blank plan. Fix: `importOsm`/`importOsmBbox`/`loadSample`/
  `setStage`/`goTo` all clear `importBox` + `exportBounds`.
- **[med] Direct tool broke selection outside Network** — nodes/vertices only
  render in the network stage, so Direct elsewhere killed click-to-select. Fix:
  Direct is gated to the network stage (toolbar disables it; `a` key ignored).
- **[med] box-draw not mutually exclusive with tools / not cleared on stage
  switch** — could leave the stage undraggable or fire two modes on one click.
  Fix (state machine): `setBoxDraw` forces `tool:'select'`, `setTool` clears
  `boxDraw`, `setStage` clears `boxDraw`; `onClick` early-returns while a box is
  active. Now provably exclusive.
- **[med] `goTo` re-anchored origin without dropping boxes** (world-metre boxes
  pointed at the wrong place after re-anchor). Fixed with the extent-clearing above.
- **[low] `setStage` left `patchDraft`/`patchKind`/`placeKind` armed** across
  stages. Fixed (cleared on every stage change).
- **[low] `selectedEdgeId` was in the undo slice but `selectedEdgeIds` wasn't**
  → primary/multi-selection drift after undo. Fix: `selectedEdgeId` removed from
  `partialize` (it's derived by `pruneSelections`).
- **[low] box-draw shared `regionRef` with lasso render** → a spurious lasso
  quad could paint over the box. Fixed by the tool/box exclusivity + a `!boxDraw`
  render guard.

Regressions locked in `store.test.ts` (tool/box exclusivity, stage clearing,
goTo box clearing). Suite: **18 tests, all green** (`npm test`).

---

## 5. How to extend the app (contributor guide)

**Add a stage:** add to `Stage` (`types.ts`), the `STAGES` array
(`FloatingUI.tsx`), the `STAGE_KEYS` map + panel switch (`App.tsx`), and a
`*Panel.tsx`. Canvas layers gate on `stage` in `CanvasStage.tsx`.

**Add a tool:** add to `Tool` (`types.ts`), the `TOOLS` array
(`FloatingUI.tsx`, with `stages` if restricted), the `TOOL_KEYS` map
(`App.tsx`), and handle it in `CanvasStage.tsx` (`onMouseDown/Move/Up`, cursor,
hint). Prefer routing new selection/drag tools through the future
`HandleLayer` (P2) rather than a new bespoke handler.

**Add a derived artifact:** compute it purely from the graph in a `graph/` or
`sections/` module, expose it through `deriveNodeArtifactsCached` or a sibling
memoized selector, render it in `CanvasStage.tsx`, and include it in
`export/plan.ts:planContent`. Never store what you can derive (§2 of
ARCHITECTURE). If users must tune it, store **parametric overrides keyed by a
stable key**, not the geometry.

**Add a store field:** if it should undo, add it to `partialize` **and** the
`equality` check, and reconcile it in `pruneSelections` if it references
edges/elements/patches. UI-only state stays out of both.

**Golden rules:**
- Geometry in metres, y-down; lat/lon only at `osm/overpass.ts` and geocoding.
- One pure op = one undo step; pause/resume temporal during drags.
- Every engine fix gets a vitest regression; every interactive change gets a
  Playwright drive and an actually-viewed screenshot.
- Read `ARCHITECTURE.md` §3 (coordinate handedness) and §11 (gotchas) before
  touching geometry.
