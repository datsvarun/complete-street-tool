# Node-Mesh Street System — topology prototype

Interactive scaffold for the shared-node mesh idea behind the Complete Street
Tool: after the centerline network is fixed, the entire street — carriageway,
cycle tracks, footpaths, junctions, corners — is generated as **one connected
mesh**. Every point exists exactly once; every polygon holds exactly one
function and references points by id. Abutting geometry is therefore connected
*by construction*: drag the node where footpath meets carriageway and both
reshape together.

## Run it

No build step, no dependencies. Open `index.html` in a browser (double-click,
or `npx serve` if you prefer). `index.html#mesh` deep-links straight to the
generated mesh.

## The two phases

1. **Centerline** — drag graph nodes to shape the skeleton (red lines, grey
   right-of-way envelope). This mirrors the `network = {nodes, edges}` state in
   the main tool's `App.jsx`.
2. **Mesh** — one click generates the mesh. From here on, editing happens on
   mesh nodes, not centerlines. Hover a node to see every face it drives
   (strip + junction + corner at once); drag it and they all reshape together.
   Hover a face to read its function and area.

## Files

| File | Role |
|---|---|
| `mesh-core.js` | Pure topology/geometry engine. No DOM. Loads in the browser (`window.MeshCore`) and in Node (`module.exports`) so it is unit-testable and portable into `complete-street-tool/src/geo/`. |
| `index.html` | Canvas UI: viewport, rendering, drag/hover interaction, controls. |

## Data model

```
mesh.nodes : Map<nodeId, {x, y}>                      // each point exists ONCE
mesh.faces : [{ id, fn, kind, nodes: [nodeId, ...] }] // polygons reference ids
```

- `fn` — the single function of the face: `footpath | cycletrack | carriageway | junction`.
- `kind` — how it was produced: `strip` (longitudinal quad along an edge),
  `junction` (carriageway box at a degree-3+ node), `corner` (footpath/cycle
  band wrapped around the corner between two adjacent legs).

Because faces store ids rather than coordinates, "connected geometry" needs no
constraint solver: moving a node in the `Map` moves it in every face that
references it. `buildAdjacency()` gives the reverse index (node → faces) used
for highlighting and could later drive selection/validation.

### How sharing is constructed (`generateMesh`)

Graph nodes are classified by degree:

- **Degree 1** — squared end cap; boundary nodes owned by that edge end.
- **Degree 2 (bend)** — one *mitred* set of boundary nodes, shared by both
  incident edges' strips (each edge maps its left/right boundary index onto the
  shared frame, flipping `k ↔ K-k` when its stored direction opposes the
  through-travel direction).
- **Degree 3+ (junction)** — each leg is set back by an angle-aware trim
  (`(ROW/2)/tan(θ/2)` + margin, so acute corners stay proper), then:
  - the **junction box** walks each leg's two carriageway-edge nodes in angular
    order — the same nodes the leg strips end on;
  - **corner faces** connect each non-carriageway band between angularly
    adjacent legs, reusing the legs' end nodes on both sides.

Edge strips are subdivided longitudinally at the chosen segment length, so
edits stay local (the cross-ties in the concept sketch).

## Tests

```
node test-mesh-core.js
```

The headless suite checks the invariants that make the concept work: all face
node refs resolve, no degenerate faces, bend nodes shared across both edges,
every junction-face node also used by a leg strip, and — the headline — moving
one shared node changes exactly the faces adjacent to it (strip + junction +
corner simultaneously) and nothing else.

## Mapping onto complete-street-tool

| Prototype | Main tool |
|---|---|
| `graph = {nodes, edges}` | `network` state in `App.jsx` (same shape) |
| `bands = [{fn, w}]` | IRC config `components: [{element, width}]` from `src/irc/loader.js` |
| `generateMesh(graph, bands, segLen)` | replaces per-edge `generateStreetPolygons()` in `src/geo/streetGeometry.js` |
| `mesh-core.js` | natural home: `src/geo/graph.js` (currently an empty placeholder) |
| canvas faces | GeoJSON features (`element` property = `fn`), rendered by MapLibre as today |
| metres, y-down plane | lng/lat via the existing flat-earth conversion (`111132 m/deg`) |

Key differences from the current generator: today each edge is offset
independently and overlaps at junctions; the mesh generator makes leg trims,
junction boxes, and corner wraps explicit, and every boundary is shared.

## Deliberate simplifications (next steps)

- **Corners are straight chamfers** — production would insert arc fillets
  (kerb radii per IRC) as extra nodes along the corner edge.
- **Uniform cross-section** — every edge uses the same band list; per-edge IRC
  configs need band-matching at junctions (drop/merge bands when legs differ).
- **Manual edits don't survive regeneration** — node ids are stable
  (`jct:B:EB:2`, `bend:M:3`, `st:AB:4:1`), so persisting user edits as
  per-id displacement deltas and re-applying after regeneration is the
  intended upgrade path.
- **No node insertion/merge tools** — splitting a face edge (adding a node
  mid-boundary) and welding nodes are the obvious next editing operations;
  a half-edge structure would make face-adjacency queries cheaper if editing
  grows beyond drag.
- **No lane markings** — the main tool's separator lines would become
  polylines referencing mesh node ids, inheriting the same shared editing.
