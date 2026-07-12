# CST · IRC Street Designer — System Architecture

**Audience:** an engineer or agent picking this codebase up cold. Read this
top-to-bottom once; afterwards each module should be modifiable in isolation.

**Governing docs (repo root):**
- `IRC_Street_Designer_Plan_v2.md` — the plan. Sole authority for scope and
  phase order. Section references below (e.g. "§1.2") point here.
- `Junction_Tool_Design.md` — junction tool deep design; slices J1–J7
  (J1–J4 shipped, J5–J7 open).
- `End_to_End_Design.md` — full-app ideation (persistence, start flow,
  detailing scope); build-order suggestions, not commitments.
- `Case_Study.md` — algorithm ports (osm2streets / Streetmix / LaneMaker)
  with pseudocode. Reference only, never a task list.
- `CLAUDE.md` — working rules. App code in `/app`; docs at root; **all
  geometry in a local metric CRS, lat/lon only at the map boundary**; one
  phase-slice per session.
- `ROADMAP.md` — what's done, what's next, in what order; contributor
  extension guide. **Start here to pick up work.**
- `CAD_Architecture.md` — design for node-level editing of derived geometry
  (the keyed-vertex layer).

---

## 1. What this is

A **client-only** web app (no backend, no persistence yet) for designing
IRC-compliant Indian urban streets end to end:

> import/draw a street network → assign IRC SP:118-2018 cross-sections →
> derived junction geometry with editable corners → street furniture &
> markings → print a scaled vector plan.

Deployed via GitHub Pages *deploy-from-branch*: `npm run deploy:pages` builds
with `base: './'` and copies `dist/` to the **repo root** (`index.html`,
`app-assets/`, `.nojekyll`). Pushing the branch is the deploy.

## 2. The one architectural rule: derived, not stored (§1.2)

The store holds only **decisions**; everything visual is **recomputed from
scratch on every graph change**:

| stored (undoable)                          | derived (every render)                        |
|--------------------------------------------|-----------------------------------------------|
| graph nodes/edges (+ per-edge section)     | ribbon band polygons, lane markings           |
| projection origin (lat/lon of local 0,0)   | transitions between differing sections        |
| `JunctionDesign` overrides (only if touched)| junction surfaces, fillet arcs, wedges, trims |
| `StreetElement` anchors (station+component)| element world positions & symbol polygons     |
| `Patch` polygons (edit stage)              | — drawn verbatim; the manual escape hatch     |

Consequences: there is no invalidation logic anywhere — mutate the graph and
every artifact regenerates; user overrides survive regeneration because they
are keyed **parametrically** (edge ends, stations, component indices), and go
*stale* rather than *wrong* when their anchor disappears.

## 3. Coordinate system

Local tangent equirectangular plane, **metres, y-down** (screen-like):

```
x = (lon − lon₀) · 111320 · cos(lat₀)        y = −(lat − lat₀) · 111320
```

`origin` (lat₀, lon₀) lives in the undoable store slice; it is set by OSM
import or by geocoding onto an empty graph, and is the only bridge to lat/lon
(`app/src/osm/overpass.ts: toLocal/toLatLon`). The MapLibre basemap is
*slaved* to the Konva camera (`Basemap.tsx`): Konva owns all input; the map
`jumpTo`s with zoom `log2(78271.51696 · cos(lat) · view.scale)`.

Y-down flips handedness: **ascending `atan2` = clockwise on screen**, and the
"left normal" of a segment `(dx,dy)` is `(dy, −dx)` (see `leftNormal` in
`geometry/polyline.ts`). Every orientation bug so far traced back to one of
these two facts — check them first.

## 4. Data model (`app/src/types.ts`)

```
GraphState { nodes: Record<id, {x,y}>, edges: Record<id, StreetEdge>,
             nextNodeNum, nextEdgeNum }

StreetEdge { a, b: node ids            // endpoints; points[] mirrors them
             points: number[]          // flat centerline [x0,y0,x1,y1,...]
             section: EdgeSection|null // materialized cross-section
             overrides?: SectionOverride[]  // station-anchored mid-edge changes
             highway?, name?, oneway?, lanes?,
             carriagewayType?: 'divided', medianWidth? }

EdgeSection { catalogId,               // provenance; null once hand-built
              components: SectionComponent[],  // ordered LEFT → RIGHT
              refM?: number }          // metres from LEFT edge where the
                                       // drawn centerline sits (default ½ total)

JunctionDesign { type, cornerOverrides:  Record<cornerKey, {radiusM?, chamfer?}>,
                 approachOverrides: Record<edgeEndKey, {trimM?}>, touched }
   // junction key = sorted node ids joined '+'
   // edgeEndKey   = `${edgeId}:${'start'|'end'}`
   // cornerKey    = `${edgeEndKeyA}|${edgeEndKeyB}`

StreetElement { kind, edgeId, stationM,      // along the centerline
                compIndex, t,                // across: component + 0..1 fraction
                variant?, widthM?, placedBy? }

Patch { kind: ComponentKind | 'cut',         // edit stage: free-form polygon
        points: number[] }                   // painted material or ground cut
```

**Invariants:**
- `edge.points` first/last pair equals node a/b coordinates (ops maintain it).
- The graph is planar: `commitDraft` auto-nodes crossings; node drag onto an
  edge welds+splits.
- Node classification (terminus/bend/junction/crossroads) is **derived from
  degree**, never stored (§1.3).
- `refM` ("reference line") generalizes left/center/right alignment: all
  cross-street offsets are computed as
  `offset = total·refFraction − Σ(widths left of the point)`, so bands,
  curbs, elements, and exports all agree on where the drawn line sits within
  the section. When an edge is traversed *reversed* (from its `b` end),
  components reverse and the fraction mirrors: `f → 1 − f`.

## 5. Module map (`app/src/`)

| module | responsibility | key exports |
|---|---|---|
| `geometry/polyline.ts` | flat-polyline math: length, station point+normal, projection, offset (miter, limit 4), sub-polyline, seg-seg intersection, Douglas-Peucker, point-in-polygon | `pointAtStation`, `projectOnPolyline`, `offsetPolyline`, `subPolyline`, `segSegIntersection`, `ribbonBand` |
| `geometry/ribbon.ts` | section → band polygons + separator markings (3DStreet pattern: dashed between same drivable kinds, solid otherwise) | `buildRibbon`, `refFraction`, `RibbonBand` |
| `catalog.ts` | IRC SP:118-2018 cross-section catalog; element-name → `ComponentKind` classifier; kind colors/labels; the **shared DRIVABLE set** (flush-with-carriageway kinds) used by both junction curbs and element placement | `CATALOG_BY_ROW`, `getSection`, `KIND_COLORS`, `DRIVABLE_KINDS` |
| `sections/rules.ts` | OSM highway class → catalog section auto-assignment + review list | `autoAssignSections`, `materialize` |
| `sections/transition.ts` | **the blending engine.** Width-weighted LCS over kind tokens (carriageway groups `cw (median cw)*` match as units, so divided↔single merges as a Y); smoothstep band sampler along any path; span resolution (base + overrides + derived transition zones); trimmed edge geometry | `matchComponents`, `sampleTransitionBands`, `buildEdgeGeometry` |
| `graph/ops.ts` | pure graph operations, one undo step each: draft commit (planarize), split (clips overrides), move/merge/weld/delete, join-through-node (returns a `JoinResult` with reversal/length metadata so the store can re-anchor elements), simplify; shared `graphBounds` (covers edge interior vertices) | `commitDraft`, `splitEdge`, `mergeNodes`, `joinThroughNode`, `graphBounds`, `degree` |
| `graph/transforms.ts` | osm2streets cleanup pipeline: short→degenerate→short | `runStandardPipeline` |
| `graph/dualCarriageway.ts` | detect / manually merge parallel oneway pairs into a divided edge (orientation-aware: `bearingDiff > 90°` ⇒ reverse one side) | `detectDualCarriageways`, `mergeDualCarriageway`, `manualDcCandidate` |
| `graph/junctions.ts` | **the junction engine** (see §6) | `deriveNodeArtifactsCached` (single-entry identity cache — canvas, panels, suggestions and export all share one derivation per state change; `deriveNodeArtifacts` is the uncached pure function) |
| `detailing/elements.ts` | parametric street furniture: per-kind allowed component lists, drop/drag resolution to the nearest legal band, shared symbol geometry (canvas+SVG), lane dividers, auto-suggestion generators, anchor validity (`isElementValid` / `pruneElements` — stale anchors render nothing and are pruned by the store) | `resolveDrop`, `elementGraphics`, `laneDividers`, `suggestElements`, `componentSpan`, `drivableSpan`, `pruneElements` |
| `export/plan.ts` | whole-design → standalone SVG plan (title block, scale bar, legend) reusing the same derivations as the canvas; split into `planContent` (expensive, design-dependent) + `framePlanSvg` (cheap title-block framing) so title edits don't re-derive the network | `planContent`, `framePlanSvg`, `buildPlanSvg` |
| `osm/overpass.ts` | Overpass bbox import (45 s abort) with user filters (flyovers/service/paths) + bus-stop layer, lat/lon⇄local projection, way parsing/filtering | `fetchOverpassBbox`, `parseOsm`, `parseBusStops`, `ImportFilters`, `toLocal`, `DEFAULT_IMPORT` |
| `geometry/spatialIndex.ts` | uniform-grid edge index (CAD P1), memoized per edges-record identity; all hit tests (`findSnap`, `resolveDrop`, node-drag snap) query local candidates only | `edgesNear` |
| `cad/vertexOverrides.ts` | **CAD keyed-vertex engine** (P3/P4): parametric (along, across) nudges per perimeter-fraction key, re-applied to every regenerated outline; unmatched keys skip (stale, not wrong). Shape keys: `band:{edgeId}:{bandKey}`, `jring:{jKey}`, `jband:{jKey}:{bandKey}` | `applyShapeOverrides`, `deltaForDrag`, `vertexFractions` |
| `persistence.ts` | versioned `.cst.json` document (= the decision slice), structural validation with forward-compatible defaults, debounced localStorage autosave + restore | `toDocument`, `fromDocument`, `downloadDocument`, `readAutosave` |
| `store.ts` | one zustand store for all stages + zundo temporal undo (see §7); also boundaries (traced plot/ROW polylines), vertexOverrides, busStops, importFilters | `useCst` |
| `components/CanvasStage.tsx` | the canvas: view/camera, all Konva layers, draw/snap, marquee/lasso, drag interactions, hover cursors, floating canvas chrome | `CanvasStage` |
| `components/FloatingUI.tsx` | stage rail, tool rail, basemap FAB, scale bar, compass | |
| `components/*Panel.tsx`, `StripEditor.tsx` | per-stage panels; StripEditor = bottom-sheet cross-section editor (widths, add/remove, flip, draggable refM arrow with snapping) | |
| `components/Basemap.tsx`, `GeocodeSearch.tsx` | slaved MapLibre raster basemap; Nominatim search (re-anchors origin only when the graph is empty) | |

## 6. The junction engine (`graph/junctions.ts`)

`deriveNodeArtifacts(graph, junctionDesigns?) → { junctions, transitions, trims }`
runs on every graph change (memoized per consumer). Pipeline per §4 of
`Junction_Tool_Design.md`:

1. **Group** edges by node; nodes with degree ≥ 3 are junction seeds.
2. **Pass 1 — singleton trims:** compute each junction alone; if the trims of
   two junctions consume ≥ 75 % of a shared edge, union-find **merges them
   into a cluster** (the shared edge becomes internal: covered by a band and
   fully trimmed).
3. **Per cluster (`computeJunction`):**
   - **Approaches**: each outward edge, oriented *away* from the cluster,
     with signed curb offsets and raised stacks split by the DRIVABLE set
     (`carriageway, mixed, service, brt, parking` are flush; everything else
     is raised). Sorted by `atan2` angle (= clockwise on screen).
   - **Corners** between adjacent approaches (`solveCorner`): offset A's
     right curb and B's left curb **away from the drivable side** by R (the
     fillet center lives in the block corner, NOT toward the node — moving it
     inward was the root cause of the "spiral" bug); intersect for the
     center; perpendicular feet are tangent points; sample the short arc.
     R comes from `cornerOverrides` or the IRC:103 class-pair table, then
     shrinks ×0.75 until it fits. Fallback: chamfer at the curb collision.
     Trims are the max of tangent stations and **ROW-level clearance** (outer
     boundaries must not overlap).
   - **Ring**: mouth caps at curb offsets + curb segments + fillet arcs =
     carriageway surface polygon.
   - **Wedges**: the raised stacks of adjacent approaches bridge around the
     corner path via `matchComponents` + `sampleTransitionBands(path, …,
     alignF=1)` — "a corner is a transition rotated 90°". The path is
     Chaikin-smoothed and band rows are fold-clamped (`unfoldRow`) so chamfer
     kinks pinch instead of bow-tie.
   - **Noses**: inner median components end in a circle cap at the mouth.
   - **Handles metadata**: corner midpoints + bisectors (drag axis), approach
     mouths + directions, actual radii — consumed by the canvas handle layer.
   - **Movements (J4)**: every permitted entry→exit pair (oneway-aware),
     classified by signed turn angle (LHT: positive/clockwise = right),
     with a quadratic-bezier arrow path through the centroid.
4. **Degree-2 nodes** whose two edges carry *different* sections become
   **node transitions**: the transition sampler runs across the node with
   per-side `refFraction` (mirrored when an edge enters reversed).
5. **Trims** (`Record<edgeId, {start, end}>`) feed back into
   `buildEdgeGeometry(edge, trim)` so ribbons stop at junction mouths.

## 7. Store & undo (`store.ts`)

One zustand store (`useCst`) wrapped in `zundo`'s `temporal`:

- **Undoable slice** (via `partialize`): `nodes, edges, nextNodeNum,
  nextEdgeNum, origin, selectedEdgeId, junctionDesigns, elements,
  nextElementNum`. `equality` compares `nodes/edges/junctionDesigns/elements`
  by identity — an action creates a history step iff it replaces one of those
  records.
- **Drag pattern**: every continuous gesture (node/vertex/handle/element
  drag, refM arrow) calls `useCst.temporal.getState().pause()` on drag-start
  and `resume()` on drag-end ⇒ one undo step per gesture.
- **UI state** (stage, tool, draft, selections, placeKind, panel toggles,
  statusMsg, pendingFit) is *not* undoable.
- `pendingFit: Bounds` is the camera mailbox: any action can request a view
  fit; `CanvasStage` consumes and clears it.
- Dev handle: `window.__cst = useCst` (DEV only) — the Playwright drives
  depend on it.
- **Undo must go through `store.undo()/redo()`**, never
  `useCst.temporal` directly: the wrappers re-validate volatile selections
  (`pruneSelections`) against the restored snapshot so
  `selectedEdgeIds`/`selectedElementId`/`selectedJunctionKey` never dangle.
- **Element anchor lifecycle**: graph mutations keep `elements` honest —
  `splitEdgeAt`/`weldNodeToEdge` re-anchor stations across the split halves,
  `removeNodeSmart`'s degree-2 heal remaps stations/sides across the join
  (mirroring `compIndex`/`t` when an edge reverses), `flipSection` mirrors
  anchors with the section, and destructive ops (`removeEdges`, `deleteNode`,
  `cleanNetwork`, DC merge) call `pruneElements`. Imports clear
  `elements`/`junctionDesigns`/selections entirely — edge ids are recycled
  (`e1…`), so stale anchors would silently rebind to unrelated streets.

Actions are grouped by domain: graph ops (delegate to `graph/ops.ts`),
section ops (materialize catalog copies — **copy-on-write**, edits never
touch the catalog), junction design ops (stable-key overrides), detailing ops
(place/move/remove/suggest via `detailing/elements.ts`), import/geocode.

## 8. Canvas (`components/CanvasStage.tsx`)

Konva `Stage` in world metres with `x/y/scaleX/scaleY` as the camera; wheel
zooms about the pointer (`MIN_SCALE 0.2` – `MAX_SCALE 60` px/m). Layer order:

```
Basemap (DOM, below)             MapLibre, input-dead, slaved to view
GridLayer                        only when no basemap
artifacts layer                  junction cover bands → surfaces → wedges →
                                 noses → node transitions   (stage ≠ network)
EdgesLayer                       per-edge ribbons/markings (trimmed), dotted
                                 ROW outline in network stage
VerticesLayer / NodesLayer       network stage only; drag = move w/ snap-merge
                                 & weld; right-click = smart delete
JunctionHandlesLayer             selected junction: movement arrows, corner
                                 radius dots, mouth trim squares
DetailingLayer                   lane dividers + element symbols; drag re-
                                 resolves to nearest legal band each frame
overlay layer                    draft polyline, snap ring, marquee/lasso
```

Interaction notes (hard-won — do not "simplify" these away):
- **Konva synthesizes dblclick** from any two clicks within its time window
  regardless of distance. Draw-finish therefore requires the last two draft
  points to be < 6 screen px apart ("stationary double-click").
- **Snap must be computed synchronously in onClick** (`findSnap` call), not
  read from the mousemove-updated state — a fast click after a snapped click
  would otherwise reuse the stale snap and silently eat the draft.
- Region selection: marquee = world rect, lasso = polygon; hits sample edge
  polylines subdivided to ≤ 8 m; Shift = add, Ctrl/Cmd = toggle.
- Hover cursors are set imperatively on the Konva container
  (`hoverCursor(cur)` props helper); the container style is the per-tool
  fallback.
- Floating chrome inside `.canvas-host` must carry the `overlay` class —
  a CSS rule keeps every *other* direct child `position: relative` so the
  Konva stage stacks above the basemap. That rule also out-ranks
  maplibre-gl.css's late-loading `position: relative` (which once collapsed
  the map to zero height — see §11).

## 9. UI shell (`App.tsx`, `FloatingUI.tsx`)

- Slim header: brand, **standard tool toolbar** (Selection ➤, Direct ▷ —
  moves nodes/vertices, Rect, Lasso, Draw, Split; draw/split disable outside
  the network stage), Nominatim geocode search, design-opacity slider,
  undo/redo. Stage panels carry only their domain-specific choices.
- **Stage rail** (left edge, vertical): Network → Street → Junction →
  Detail → **Edit** → Export. Clicking the active stage toggles the
  **floating panel** beside the rail (`panelOpen` is App-local state).
- **Edit stage**: free-form patches — pick a material (or 'cut'), click
  vertices, Enter/double-click closes; vertices drag, right-click removes.
  Patches render above the derived design and export with the plan.
- **Section multi-apply**: catalog clicks apply to every selected street
  (`assignSectionToSelected`, one undo step).
- **OSM import by area**: draw a bbox on the canvas (live size/area readout,
  capped at 3 km²), confirm → exact-extent Overpass query re-anchored at the
  box centre. **Export extent**: draw a crop box; the plan frame clips to it.
- Bottom-left: basemap FAB (none/OSM/satellite) + reactive scale bar
  (1/2/5×10^k m targeting ~90 px). Top-right: compass (north-up; click =
  fit). Bottom-center: hint pill. Bottom-right: cursor coordinates.
- **Keyboard map** (window listener in `App.tsx`, skipped when typing):
  `1–6` stages · `V/A/M/L/D/X` tools (A = Direct) · `F` fit · `P` panel
  toggle · `Ctrl+A` select all · `Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` undo/redo ·
  `Enter` finish draft/patch · `Esc` cancel-chain (box draw → draft → patch →
  place tool → tool → selections) · `Delete` removes patch/element/edges.

## 10. Verification workflow (vitest + drive the real app)

Unit tests: `npm test` (vitest) covers the pure engine — `graph/ops.test.ts`
(commitDraft planarity incl. the snap-after-split regression, self-loop
guards, join metadata, graphBounds), `graph/transforms.test.ts` (short-edge
collapse never leaves self-loops, divided/undivided splice guard, DC-merge
shared-endpoint guard), `sections/transition.test.ts` (matcher symmetry,
Y-merge, flip continuity). Add a regression test with every engine bug fix.

Playwright drives the real app for everything interactive:

Scripts live in the session scratchpad (not committed) and target a dev
server on **port 5199**:

```js
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
await page.route('**/tile.openstreetmap.org/**', r => r.fulfill({ contentType: 'image/png', body: validStubPng }));
// state inspection:
await page.evaluate(() => window.__cst.getState().edges);
// engine functions can be imported in-page:
await page.evaluate(() => import('/src/graph/junctions.ts'));
```

Rules learned the hard way:
- Stub tiles **must be valid PNGs** — aborted/invalid tiles once masked a
  real basemap-invisible bug for two rounds of review.
- `page.mouse.click(x, y, {modifiers})` does not exist — wrap clicks in
  `keyboard.down('Shift') … keyboard.up('Shift')`.
- Screenshots must actually be **looked at**; "no page errors" alone has
  repeatedly passed visually-broken geometry.
- Draw clicks need ~450 ms gaps or Konva's dblclick synthesis truncates the
  polyline.
- npm scripts run from `/app` (`npm run dev/build/lint/deploy:pages`);
  lint = oxlint, typecheck = `npx tsc -b`.

## 11. Gotchas & past incidents (check here before re-debugging)

1. **Basemap invisible in prod**: maplibre-gl.css loads after index.css and
   its `.maplibregl-map{position:relative}` beat our absolute positioning at
   equal specificity → container height 0. Fixed with the higher-specificity
   `.canvas-host > .basemap` rule. Don't lower its specificity.
2. **Fillet center side**: the corner arc's center must sit *beyond* the
   curbs in the block corner. Offsetting toward the centerline produces
   tangent points on the node side and 270° reflex arcs (the "cinnamon roll"
   junctions).
3. **Weighted LCS tie-breaks**: component matching must stay symmetric
   (A→B mirrors B→A) — the width-weighted LCS in `matchComponents` exists
   because count-LCS tie-breaking made a reordered cycle track taper out at
   one node but slide across the footpath at the next.
4. **`pkill -f`** patterns can match their own shell — use `'[v]ite'`-style
   patterns.
5. **Wedge taper tongues**: where completely unmatched stacks meet at a
   corner (7 m livability island vs footpath+cycle+MUZ), the drop/introduce
   tapers sweep outward ~2 m. Known cosmetic; the fix is slice J7's probe
   method, not more special-casing in the sampler.
6. **`refM` re-anchoring**: resizing components to the LEFT of the reference
   line shifts the whole street sideways (refM is metres from the left edge).
   Deliberate for now; flagged in StripEditor work.
7. **Known debt** (reviewed, deliberately deferred): cumulative
   component-offset math exists in three specialized forms (`buildApproach`,
   `componentSpan`/`drivableSpan`, `buildRibbon`) — unify only with care, the
   reversal/fallback semantics differ; `commitDraft`'s internal splits drop
   elements via pruning rather than re-anchoring; no spatial index yet for
   `findSnap`/`resolveDrop` (fine ≤ ~200 edges); junction-handle drags stash
   their baseline on Konva nodes via `setAttr('dragFrom')`.

## 12. Roadmap (agreed, not yet built)

- **J5** priority/signalized junction templates: crossings, stop lines,
  refuges, signal markers, right-turn pockets *as sectionOverrides*, greedy
  conflict-graph phase plan (consumes the J4 movement graph).
- **J6** roundabout template; **J7** probe-method boundaries for 5+/shallow
  corners + validation warnings surfaced like the review list.
- Persistence MVP: autosave to localStorage, save/open `.cst.json`
  (schema: graph slice + origin + junctionDesigns + elements), GeoJSON
  export (`End_to_End_Design.md`).
- Detailing depth: element properties (rotation, spacing), signs/signals,
  property-entrance interaction with footpath geometry.
