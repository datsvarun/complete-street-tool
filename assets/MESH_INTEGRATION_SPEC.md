# Node-Mesh System — Integration Specification for Complete Street Tool

**Audience:** the implementing agent working in `complete-street-tool`
(github.com/datsvarun/complete-street-tool). This document is self-contained:
it recaps the validated prototype, defines the target architecture, then
specifies eight feature areas with data-model implications, algorithms, and
acceptance criteria. Where a decision is left open, the recommended option is
marked **(recommended)**.

---

## 1. Context

### 1.1 What exists today (main tool)

- React 19 + Vite + MapLibre GL, plain JS. All state in `src/App.jsx`.
- Centerline network: `network = { nodes: {id:{lng,lat,source}}, edges: {id:{from,to,...}} }`.
  Edges are straight 2-node segments.
- `src/geo/streetGeometry.js` → `generateStreetPolygons(centerlinePoints, crossSection, driveSide)`
  offsets IRC cross-section bands (`components: [{element, width}]` from
  `src/irc/loader.js`) perpendicular to each edge **independently**. Output:
  flat GeoJSON FeatureCollection rendered by MapLibre.
- **No shared topology, no intersection geometry** — streets overlap at
  junctions. `src/geo/graph.js` is an empty placeholder.
- Coordinates: WGS84 lng/lat; metres↔degrees via flat-earth
  (`111132 m/deg`, `cos(lat)` for lng).

### 1.2 What the prototype proved (`d:\Code\Street_Generator\node-mesh-system`)

Study these three files before writing code:

| File | Content |
|---|---|
| `mesh-core.js` | Pure engine: `generateMesh(graph, bands, segLen)` → `{nodes: Map, faces: []}`. Degree-1 = squared cap; degree-2 = mitred boundary set **shared by both edges**; degree-3+ = angle-aware leg trim + junction box + corner faces, all reusing the legs' end nodes. |
| `test-mesh-core.js` | 15 invariant tests (all passing). The headline test moves one shared node and asserts exactly the adjacent faces change. |
| `index.html` | Canvas demo of the two-phase workflow and drag-editing UX. |

**The core principle — everything below depends on it:**

```
mesh.nodes : Map<nodeId, {x, y}>                       // every point exists ONCE
mesh.faces : [{ id, fn, kind, nodes: [nodeId, ...] }]  // polygons reference ids
```

Faces store node **ids**, never coordinates. Abutting geometry is connected by
construction: moving a node reshapes every face that references it. There is no
constraint solver. Every editing operation in this spec reduces to: create
nodes, move nodes, rewrite face id-lists — while keeping shared boundaries
expressed as shared ids.

Node ids are **stable and semantic** (`jct:B:EB:2`, `bend:M:3`, `st:AB:4:1`,
`cap:A:0`): same graph + same parameters ⇒ same ids. Preserve this property;
features 7 (edit preservation) depends on it.

---

## 2. Target architecture

### 2.1 Where the code goes

- Port `mesh-core.js` into `src/geo/graph.js` (the empty placeholder) or a new
  `src/geo/mesh/` directory **(recommended: directory)** — it will grow:

```
src/geo/mesh/
  generate.js     // generateMesh + junction/bend/cap construction (from prototype)
  operations.js   // all edit operations of §4–§5 (insert, weld, split, merge, delete, retype)
  curves.js       // fillet/curve registry (§5.1, §5.6)
  snapping.js     // lane-grid snapping engine (§5.8)
  adjacency.js    // node→faces index, boundary-segment→faces index
  serialize.js    // mesh ↔ GeoJSON (render + persistence)
```

- Keep every module **pure and DOM-free** (like the prototype) so the whole
  editing layer is unit-testable in Node. React components call operations and
  re-render; they never mutate the mesh directly.

### 2.2 Coordinate plane **(important)**

Do all mesh math in a **local metre plane**, not lng/lat:

1. On generation, project every graph node: origin = network centroid,
   `x = (lng-lng0)·111132·cos(lat0)`, `y = -(lat-lat0)·111132` (negate so the
   plane is y-down like the prototype; keep one convention everywhere).
2. Generate and edit the mesh entirely in metres.
3. Convert to lng/lat only in `serialize.js` when emitting GeoJSON.

This keeps widths, trims, snap tolerances, and arc radii in real metres and
makes the prototype code drop in unchanged.

### 2.3 Rendering & interaction on MapLibre

- `serialize.js` emits one FeatureCollection: a Polygon feature per face with
  properties `{fn, kind, faceId}` (reuse the existing `element` property name
  so `componentColors.js` and the legend keep working), plus a Point feature
  per mesh node `{nodeId}` when node display is on.
- Layers: fill per face (color by `fn` via existing color map), thin line
  layer for wireframe, circle layer for nodes, and a **guides** line layer
  (§5.1 lane guidelines, dashed).
- Interaction mirrors the existing node-drag wiring in
  `src/components/MapView.jsx` (mousedown/mousemove/mouseup on the circle
  layer, `dragPan` disabled during drag), plus:
  - `contextmenu` event → context menu component (§3.1);
  - hover → outline all faces adjacent to the hovered node (port from
    prototype; it is the feature's best self-explanation).
- App state gains a mode: `appPhase ∈ 'network' | 'mesh'`. Existing tools
  (draw/delete/OSM/collapse) operate in `'network'`; everything in this spec
  operates in `'mesh'`. Generation runs per **connected component** of the
  network using that component's selected IRC configuration.

### 2.4 Cross-section source

`bands` come from the selected IRC configuration
(`components: [{element, width}]` → `[{fn: element, w: width}]`). The
prototype assumes one carriageway band and symmetric sides; the generator
should accept any band list but MAY (for v1) require all edges of a connected
component to share one configuration. Per-edge configurations with
band-matching at junctions are explicitly out of scope for v1 — note it in
code as a TODO.

---

## 3. Cross-cutting systems (build these first)

### 3.1 Context menu

One reusable component. Right-click hit-tests in priority order:
**node → boundary segment → face → map**. Menu contents per target are defined
in §5. Boundary-segment hit-testing: a segment is a consecutive id pair in any
face loop; build a `segmentKey(a,b) = a<b ? a+'|'+b : b+'|'+a` →
`[{faceId, position}]` index in `adjacency.js` (needed by §5.1, §5.2, §5.5).

### 3.2 Operations layer + undo

Every mutation goes through a single `applyOperation(mesh, op)` entry point in
`operations.js`, which:

- validates preconditions, mutates, and returns `{mesh', inverse}`;
- pushes `inverse` onto an undo stack (App state). Ctrl+Z / Ctrl+Y required —
  mesh editing without undo is not shippable;
- records the op in `mesh.editLog` (see §5.7);
- re-runs cheap invariants in dev builds (§6): all face refs resolve, no
  face with fewer than 3 distinct nodes, no NaN.

### 3.3 Dirty tracking

`mesh.dirty = false` on generation; every operation sets it `true`. Drives
§5.7 and the "unsaved edits" UI badge.

---

## 4. Data-model extensions

The prototype model is kept, with four additions:

```js
mesh.nodes    // Map<id, {x, y}>  — unchanged
mesh.faces    // [{ id, fn, kind, nodes: [id], holes?: [[id]] }]
mesh.curves   // Map<curveId, { kind:'segment'|'corner', anchors:[idA,idB]|[idCorner],
              //   params:{sagitta|radius}, generated:[id,...], original?:{...} }>
mesh.editLog  // [{op, args, ts}]  — manual edits since generation
mesh.dirty    // boolean
```

- **`holes`** — optional interior rings (for pedestrian islands, §5.1b).
  GeoJSON Polygons support interior rings natively; canvas uses `evenodd`.
- **`curves`** — registry of fillets/curves. Curves are **not** a new geometry
  type: a curve is tessellated into ordinary shared mesh nodes inserted into
  every face that contains the anchor segment/corner. The registry exists so a
  curve can be re-tessellated (radius change) or removed ("straighten"),
  restoring `original`. This is the key design decision: because tessellation
  nodes are ordinary shared nodes, **abutting faces curve together
  automatically** and every existing behavior (drag, adjacency, serialization)
  works on curves with zero special cases. A half-edge structure with true arc
  edges is the eventual upgrade if curve editing becomes heavy; do not start
  there.
- **New `fn` values**: `'island'` (pedestrian refuge), plus whatever IRC
  elements the config supplies. `componentColors.js` needs entries for
  `'junction'` and `'island'`.

---

## 5. Feature specifications

### 5.1 Junction enhancements

**(a) Fillet / curve any boundary edge.**
Right-click a boundary segment → menu: **Curve**. Prompt or drag-handle for
depth (v1: sagitta slider with live preview; default `min(2m, 0.3·segment length)`).

Algorithm (`curves.js`):
1. Segment anchors `(A,B)`; fit a circular arc through `A`,`B` with the given
   sagitta bulging **away from the face the user right-clicked in** (or toward
   it with negative sagitta — provide both in the preview).
2. Tessellate at ≤ 0.25 m chord error into new nodes `curve:{curveId}:{i}`.
3. Look up `segmentKey(A,B)` → every face containing the pair; splice the
   generated ids between `A` and `B` in each loop (reversed order for the face
   traversing `B→A`). Both abutting faces now share the arc nodes — the user's
   requirement "the adjacent shape will also be curved with the same node"
   falls out for free.
4. Register in `mesh.curves`. Right-click any generated node or the original
   segment again → **Straighten** (remove generated ids from all loops, drop
   registry entry) or **Edit curve** (re-tessellate with new sagitta; if the
   user has hand-dragged generated nodes, warn that re-tessellation resets them).

Primary use: kerb radii at junction corners — the corner faces' inner edges
(shared with the junction box) get filleted and the junction box follows.

**(b) Pedestrian islands / refuge polygons.**
A draw tool active only in mesh phase: click a sequence of points **inside a
single `carriageway`/`junction` face**, close the ring →
- new nodes `isl:{id}:{i}`, new face `{fn:'island', kind:'island'}`;
- the ring is added to the containing face's `holes` (same node ids — the
  island boundary and the hole are the same shared nodes, so dragging the
  island edge reshapes both island and surrounding carriageway).
- Validation: ring must be simple and fully inside the host face, else reject
  with a toast. Deleting an island removes the face and its hole together.

**(c) Lane guidelines across junctions.**
Toggle "Lane guides". For each junction leg, extend every band boundary
(the leg's trimmed-end boundary nodes, direction = leg outward vector,
projected across the junction box until it exits it) as a **dashed guide
polyline** on the guides layer. Guides are render-only — never mesh geometry.
They give the designer alignment references for drawing islands (b) and for
snapping (§5.8 uses the same offsets logic).

**(d) Enlarged junctions.** No bespoke feature needed: the junction box grows
by dragging its nodes (already works), and the angle-aware trim parameter
should be exposed per-junction (right-click junction face → **Junction
setback…** → re-runs only that junction's local construction; treat as a
parameterized partial regeneration, preserving ids).

**Acceptance:** curving the inner edge of a corner face visibly curves the
junction box with it; straighten restores the exact previous loops; an island
can be drawn, dragged (hole follows), deleted; guides appear/disappear with
the toggle and follow when a leg's end nodes are dragged.

### 5.2 Click-to-add node on any boundary

In mesh phase with the **Add node** tool (or double-click in select tool —
implement both, they share the code): click near any boundary segment →
1. Find nearest segment within tolerance (screen px → metres); project the
   click onto it → point `P`.
2. Create node `ins:{n}` at `P`; splice into **every** face loop containing
   that segment pair (both directions). This is mandatory — inserting into
   only one face would unzip the shared boundary and create a crack.
3. If the segment belongs to a registered curve, also record the new node in
   that curve's `generated` list (so straighten removes it).

**Acceptance:** after insertion, dragging the new node deforms both abutting
faces; face count unchanged; invariant tests still pass.

### 5.3 Node-onto-node snapping (weld)

While dragging a node, if the pointer is within tolerance (8 screen px) of
another node, highlight the target; on release, **weld**:
1. Replace every occurrence of `draggedId` with `targetId` in all face loops
   and holes; delete `draggedId` from `mesh.nodes`; merge adjacency.
2. Collapse consecutive duplicate ids in affected loops; delete any face left
   with < 3 distinct nodes or area < ε (record in the op result so the UI can
   toast "1 sliver face removed").
3. Weld is an operation (undoable — the inverse re-creates the node and
   restores loops).

This is how tapers form: e.g. welding a cycle-track boundary node onto the
footpath boundary pinches the cycle band to zero at that station → bus bay
entries, kerb build-outs, chicane-style calming at junctions.
**Do not weld** two nodes that share no face and are far apart in function?
No — allow any weld (the user asked for free composition), but run the sliver
cleanup and show what was removed.

**Acceptance:** dragging a cycle-lane/footpath boundary node onto its
neighbor across the band produces a clean taper with no degenerate faces;
undo restores exactly.

### 5.4 Right-click a face (section)

Context menu on a face:

**(a) Change type…** → submenu of IRC elements (from `componentColors.js` /
current config) + `island`. Sets `face.fn` only. Trivial but must be an
operation (undo, editLog).

**(b) Delete.** Two cases:

- **Interior band face** (has at least one abutting face across a *lateral*
  boundary — a boundary chain shared with a face of a different band): delete
  = **absorb into a neighbor**. Find all faces sharing a boundary chain of
  ≥ 2 consecutive nodes; choose the absorber: prefer `carriageway`, then the
  neighbor with the longest shared chain. Merge (see §5.5 merge algorithm) and
  keep the absorber's `fn`. Result: deleting a cycle-track quad extends the
  carriageway into its area — the user's stated behavior. Deleting
  `carriageway` itself is allowed symmetrically (e.g. absorbed into an
  adjacent junction box or median) — if the only neighbors are non-drivable
  that is the user's choice; warn, don't block.
- **Boundary face with no neighbor on some side** (outer footpath): absorbing
  still works via its inner neighbor; the street simply becomes narrower
  there. If a face has **no** abutting face at all, offer plain removal with a
  "this leaves a gap" confirm.

**Acceptance:** delete a mid-street cycle quad → carriageway face now covers
its area, boundary nodes preserved (footpath edge untouched); undo restores
both faces.

### 5.5 Split and merge faces

**Split:** select a face → **Split** tool → click two of its boundary nodes
(or two boundary points, auto-inserting nodes via §5.2) → the loop is cut into
two faces along the straight chord `n1→n2`. Both new faces reference `n1`,`n2`
(shared). New ids `faceId.a` / `faceId.b`, both inherit `fn`. Use case:
carve a parking bay out of a carriageway quad, then retype one half (§5.4a).

**Merge:** select face, right-click an abutting face → **Merge**. Precondition:
they share a chain of ≥ 2 consecutive nodes (if they merely touch at one node,
refuse with a hint to weld/snap first — "proper node snapping" per the user).
Algorithm: walk loop A from the end of the shared chain to its start, then
loop B likewise (correct traversal directions), producing one loop; interior
chain nodes that now belong to no other face are deleted; `fn` = first
selected face's, or ask when they differ. Merge is also the engine for
delete-with-absorb (§5.4b) — implement once.

**Acceptance:** split a quad, drag the new chord nodes (both halves deform),
merge back → loop equivalent to the original (possibly rotated); shared-chain
nodes still referenced by the lateral neighbors survive the merge.

### 5.6 Curve / straighten a corner node

Right-click a **node** where two boundary segments of a face meet at an angle
(compute turn angle; offer only when > ~10°):

- **Curve corner…** → fillet: place tangent points at distance
  `r/tan(θ/2)` along both segments (clamp to 45% of each segment), tessellate
  the arc, splice into **every** face loop passing through that corner node in
  the same two segments, remove the corner node from those loops (keep the
  node itself if other faces still use it via different segments; else delete).
  Register as `kind:'corner'` in `mesh.curves` with `original` = corner node
  id + position.
- **Straighten** (on a node generated by any curve, or on a corner that has a
  registry entry): remove that curve's generated nodes from all loops, restore
  the original corner node.

Same machinery as §5.1a — implement both over one fillet primitive in
`curves.js`.

**Acceptance:** filleting the corner where footpath corner-face meets the
junction box curves both faces identically; straighten is exact (loops
byte-equal to pre-fillet state).

### 5.7 Stale-mesh protection (lost-edit handler)

Manual mesh edits do not survive regeneration, and regeneration is triggered
by: moving/adding/deleting a **centerline** node or edge, changing the IRC
configuration, drive side, or segment length.

Required behavior:
1. All regeneration triggers are gated: if `mesh.dirty`, show a blocking
   confirm — **"This street has N manual mesh edits (list of op types). Recomputing
   the mesh will discard them. Recompute / Keep mesh (cancel)"**. N and the
   summary come from `mesh.editLog`.
2. Entering network phase while `mesh.dirty` shows a persistent warning
   banner ("mesh has manual edits — centerline changes will discard them"),
   and the actual node-drag in network phase re-confirms once per session.
3. **Stretch goal (design for it, ship if cheap):** because node ids are
   stable, store manual node moves as displacement deltas
   `{nodeId: {dx,dy}}` and structural ops in `editLog`; after regeneration,
   re-apply deltas for ids that still exist and report the rest as
   "unrecoverable edits (n)". Curves whose anchor ids survive can be re-applied
   the same way. This turns the destructive warning into a mostly-lossless
   migrate.

**Acceptance:** with one dragged mesh node, moving a centerline node prompts;
cancel leaves both mesh and centerline untouched; confirm regenerates and
clears `dirty`/`editLog`.

### 5.8 Lane-grid snapping system

While dragging any mesh node, snap it to the street's **internal grid** so
edits stay dimensionally meaningful, with an escape hatch for free editing.

**Snap targets** (each individually toggleable in a Snap settings popover;
tolerance in screen px, default 10):

1. **Band boundaries** — the offset lines of the owning edge's cross-section
   (`boundaryOffsets(bands)`: every band edge at its design offset from the
   centerline). Snapping a dragged carriageway edge back to −3.5 m restores
   design width exactly.
2. **Band midlines** — midpoint offset of each band (lane centers).
3. **Half-lane / custom subdivision** — offsets at half-band steps
   (configurable divisor 2 or 4) for things like partial build-outs.
4. **Longitudinal stations** — the segment-length ticks along the edge
   (`t = t0 + k·segLen`), so nodes moved along the street land on the grid of
   cross-ties.
5. **Other nodes** — the weld snap of §5.3 (highest priority when in range).
6. **Guides** — the extended lane guidelines across junctions (§5.1c), so
   island edges can align to approaching lane edges.

Implementation (`snapping.js`): each mesh node knows its owning context from
its id (`st:AB:4:1` → edge AB; `jct:B:EB:2` → leg EB of junction B; inserted/
curve nodes inherit the context of the segment they were created on — store
`ctx` on creation). For a dragged point, compute candidate positions from the
owning edge's local frame (station along `d`, offset along `n` — both already
available in the generator), pick the nearest candidate within tolerance per
axis (offset-snap and station-snap compose, like CAD ortho grids), and return
`{snapped: {x,y}, indicators}`. Render indicators: a highlighted dashed line
for the snapped offset/station and a small tick label (`-3.50 m`, lane names
from `bands`).

**Free-editing rules:**
- Holding **Alt** during drag bypasses all snapping (standard CAD convention).
- A master "Snapping on/off" toggle in the Snap settings.
- **The outermost boundary is always free**: nodes on the ROW extremes
  (boundary index 0 or K — outer footpath edges, detectable from the id's
  boundary index or stored `ctx`) are exempt from offset snapping by default
  (station snapping may still apply), because footpath outer edges must adapt
  to plot/boundary walls. Expose this exemption as its own checkbox
  ("Snap outer edge") defaulting **off**.

**Acceptance:** dragging an inner carriageway node near its design offset
snaps with a visible indicator and exact offset value; Alt-drag places it
freely; outer footpath nodes drag freely by default; snap settings persist in
app state.

---

## 6. Invariants & testing

Port `test-mesh-core.js` into the main repo's test setup (add `vitest` — the
repo currently has no test runner) and keep its 15 assertions green. Every
operation in §5 adds tests asserting, at minimum:

1. All face node refs resolve; no NaN; no face with < 3 distinct nodes.
2. **No cracks:** every interior boundary is shared — for each segment key,
   if two faces contain it, they reference identical node ids (this is the
   invariant every splice/weld/merge must preserve; test it globally after
   each op).
3. Op + undo = identity (deep-equal on nodes and faces).
4. The headline behavior: moving any node changes exactly `adjacency(node)`
   faces.

Verification beyond unit tests: drive the real app (generate on an OSM import,
run each context-menu op, screenshot) before calling any phase done.

## 7. Suggested build order

| Phase | Scope | Exit criterion |
|---|---|---|
| A | Port engine (`src/geo/mesh/`), metre-plane projection, serialize to GeoJSON, render read-only mesh with junction boxes on the map | OSM-imported network renders as connected mesh, tests green |
| B | Mesh phase UI: node drag with adjacency highlight, dirty tracking, §5.7 warnings, undo scaffold (§3.2) | Drag edits + stale-mesh confirm work end-to-end |
| C | §5.8 snapping (band offsets/stations/weld) + §5.3 weld + §5.2 insert node | Bus-bay taper can be built by hand |
| D | §5.4 retype/delete-absorb + §5.5 split/merge (one merge engine) | Cycle lane deletable, carriageway absorbs |
| E | §5.1a + §5.6 curves/fillets (one registry), context menus complete | Kerb radii + corner fillets, straighten exact |
| F | §5.1b islands (holes) + §5.1c lane guides + per-junction setback | Refuge island drawable and aligned via guides |

Keep phases A–B faithful to the prototype before adding operations: the
prototype is the reference implementation of the topology, and its tests are
the contract.
