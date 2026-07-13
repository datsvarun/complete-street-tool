# CST — Welded Node-Mesh System (v2 SHIPPED: real `{nodes, faces}` mesh stage)

> **v2 status (this supersedes the phase table below):** the true spec mesh is
> live as a dedicated **Mesh stage** (rail position 4, between Junction and
> Detail). `src/mesh/engine.ts` builds a global `{nodes, faces}` mesh by
> welding the generator's output (2 cm hash); every point exists once and
> abutting faces share node ids. Pure ops shipped + tested
> (`src/mesh/engine.test.ts`): moveNode, insertOnSegment (all faces sharing
> the segment), retypeFace, mergeFaces, deleteFaceAbsorb, splitFace (chord),
> weldNodes (sliver collapse), cutAcross (street-wide v-split for bus bays),
> filletNode (arc spliced into every face on the corner). The mesh is
> **frozen and stored** (document/undo/autosave) — the one deliberate
> exception to "derived, not stored" — and every graph/section-mutating store
> action passes `guardMeshEdit()`: with manual edits present the user gets a
> confirm dialog; proceeding resets the mesh (spec §5.7 gate). Downstream
> stages (Detail/Edit/Export, SVG plan + GeoJSON) render mesh faces instead of
> generated surfaces while a mesh exists. Junction corner handling is a
> 3-mode setting (`common` default · `blend` · `off`) threaded through
> `computeJunction`. Spec phases A–D ✅, E partial (fillet w/o registry),
> F open (islands-as-holes, draw tool, lane-grid snapping).

**Ask (user, verbatim intent):** after the centerline network is fixed and
streets are generated, the generated geometry should behave as a node/graph
mesh — every sub-polygon holds one function, abutting geometries share nodes,
and moving a shared node (e.g. the footpath/carriageway intersection) reshapes
both polygons together. Works in the Edit stage, in conjunction with Detail.

**Spec status: RECEIVED** — `assets/MESH_INTEGRATION_SPEC.md` (+
`assets/mesh-core.js` reference engine and its 15-test contract) landed on the
branch mid-build. §0 below reconciles the shipped v1 with the spec and sets
the adapted build order. The spec is the behavioural contract; adaptations
below exist because this repo's generator is far richer than the prototype
tool the spec's §1.1 describes.

---

## 0. Spec reconciliation (read this first)

**What v1 already satisfies (behaviourally):**
- The core principle — *"moving a node reshapes every face that references
  it"* — holds: welded drags move all abutting sub-polygons, no cracks
  (`cad/mesh.test.ts` asserts the spec §6.2 no-cracks invariant at drag time).
- One function per face: CST bands/junction surfaces/wedges already are that.
- Spec §5.7's **stretch goal is v1's native behaviour**: edits are stored as
  parametric deltas keyed to stable identities and *re-applied after every
  regeneration* — CST never had the destructive-regeneration problem the spec
  §5.7 gates against, because geometry re-derives continuously.
- Spec §5.8's "outermost boundary must adapt to plot walls": v1 snaps Edit
  drags onto traced plot boundaries.

**Where v1 diverges from the spec's architecture:**
- v1 has **no materialized `{nodes: Map, faces: []}` structure** — welds are
  computed per selected shape and edits flow through `vertexOverrides`. The
  spec's operations (§5.2 insert, §5.3 weld-to-taper, §5.4 retype/delete-
  absorb, §5.5 split/merge, §5.1/5.6 curves, islands via holes) need real
  faces with node-id loops; they are not expressible as per-shape deltas.
- Spec node ids are semantic (`jct:B:EB:2`); v1 identities are
  (shapeKey, perimeter-fraction) pairs. Equivalent stability class, different
  namespace.

**Key adaptation (deliberate, flag if disagreeing):** the spec's Phase A says
"port `mesh-core.js`'s generator". That generator builds junction boxes with
angle-aware trims — *simpler than this repo's junction engine* (tangent-arc
fillets, corner wedges, median noses, transitions, divided carriageways),
because the spec was written against the prototype tool (§1.1: independent
offset bands, no junction geometry). Porting it here would regress junctions.
**Adaptation:** keep CST's generator as the geometry source and build the
spec's `{nodes, faces}` mesh by welding its output (v1's weld pass, promoted
from per-shape to global). Everything downstream of §2.1 (operations, curves,
adjacency, serialize, context menus, snapping) then follows the spec as
written. `mesh-core.js` stays in `assets/` as the topology reference and its
15 tests get ported against the welded mesh builder (§6 contract).

**Adapted build order** (spec §7, re-based on what exists):
| Phase | Spec scope | CST adaptation | Status |
|---|---|---|---|
| A | engine + render read-only mesh | global weld of derived polygons → `{nodes, faces}`; render via existing layers | **v1 ships the weld pass** (per-shape); globalize next |
| B | drag + dirty + undo | drag ✅ (v1, via deltas); freeze/edit lifecycle + editLog to add | partial |
| C | snapping + weld + insert node | boundary snap ✅; band-offset/station grid, weld-to-taper, insert-node to add | partial |
| D | retype / delete-absorb / split / merge | needs real faces — after A | open |
| E | curves/fillets registry | needs real faces — after A | open |
| F | islands (holes) + lane guides + per-junction setback | after D/E | open |

The freeze/edit lifecycle decision (spec: mesh generated once, regeneration
gated; CST today: continuous re-derivation with migrating deltas) is the one
open **product** question — v1's continuous model is strictly less destructive,
but faces created by D/E operations (splits, islands) cannot migrate through
regeneration and will need the spec's §5.7 gate once those ship.

---

## 1. The design in one paragraph

The mesh is **derived, never stored** — the same rule as everything else
(ARCHITECTURE §2). Abutting generated polygons already share coordinates *by
construction* (a carriageway band's edge and its footpath neighbour sample the
same offset polyline; band mouths meet junction caps). `cad/mesh.ts` welds
coincident vertices (2 cm tolerance, grid hash) into **shared mesh nodes**.
Dragging a node writes one parametric `(along, across)` delta **per member
shape** through the existing `vertexOverrides` engine, in a single undoable
batch (`setVertexDeltas`). Each member re-applies its own delta on every
regeneration and independently lands on the same world point — welds survive
node moves, width edits, and re-derivation, and go stale (not wrong) when a
member shape disappears.

## 2. Files

| file | role |
|---|---|
| `cad/mesh.ts` | `weldMapFor(g, artifacts, targetShapeKey)` → per-vertex member lists; `weldedDragDeltas(...)` → the multi-shape delta batch for a drag |
| `cad/vertexOverrides.ts` | unchanged substrate: perimeter-fraction keys, local-frame deltas, stale-key skipping |
| `store.ts` | `setVertexDeltas` / `removeVertexDeltas` (one undo step across shapes), `meshEdit` toggle (default **on**) |
| `components/CanvasStage.tsx` | `ShapeEditLayer` renders **green handles for shared nodes**, orange for shape-private ones; drags/right-click resets fan out to all members; nodes snap to traced plot boundaries |
| `components/EditPanel.tsx` | welded-mesh toggle + explanation |

## 3. Behaviour contract (tested in `cad/mesh.test.ts`)

1. Every vertex on a band-to-band boundary welds to its neighbour(s).
2. A welded drag lands **every** member vertex on the same world point — no
   tearing (asserted to 4 decimals after re-applying overrides per shape).
3. `meshEdit` off → drags touch only the selected shape (legacy behaviour,
   shapes may separate deliberately).
4. Right-click reset clears the node on all members.

## 4. Interaction with Detail

Elements/decals are anchored parametrically to (edge, station, component) and
re-derive from the same store state, so mesh edits and detailing coexist with
no coupling: nudged band outlines render around unchanged anchors. (A future
increment could re-project element `t` through the nudged outline — noted, not
built.)

## 5. Known limits / next increments

- Welding is computed **per selected shape** against its neighbours (bounded,
  fast). A global always-on mesh view (all nodes visible at once) is a UI
  increment on the same weld function.
- Only vertices that *coincide on the base geometry* weld. Shapes that merely
  touch along an edge without sharing sample points (rare: junction ring ↔
  raised-band mouths at fillet arcs) don't yet get intermediate welds —
  inserting matched vertices at T-junctions of outlines is the v2 item.
- Deltas are per-shape parametric; extreme resampling (corner flips
  fillet↔chamfer) can drop one member's key while keeping another → a
  formerly-welded pair separates *silently*. The Edit panel's edited-shape
  list + per-node reset is the recovery path.
