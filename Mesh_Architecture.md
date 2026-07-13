# CST — Welded Node-Mesh System (shipped v1)

**Ask (user, verbatim intent):** after the centerline network is fixed and
streets are generated, the generated geometry should behave as a node/graph
mesh — every sub-polygon holds one function, abutting geometries share nodes,
and moving a shared node (e.g. the footpath/carriageway intersection) reshapes
both polygons together. Works in the Edit stage, in conjunction with Detail.

**Spec status:** the user referenced a local spec
(`D:\Code\Street_Generator\node-mesh-system\MESH_INTEGRATION_SPEC.md`) that is
not in this repository and was not reachable from the build environment. This
document records the implemented design so the two can be **diffed and
reconciled** once the spec is committed/pasted. Flag divergences here.

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
