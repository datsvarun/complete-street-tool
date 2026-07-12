# CST — CAD Editing Architecture (design, not yet built)

**Status:** design document. Defines how CST becomes a CAD-grade editor —
node-level control over *every* generated shape — without abandoning the
"derived, not stored" rule that makes the whole app coherent
(`ARCHITECTURE.md` §2). Read `ARCHITECTURE.md` first.

**The one idea:** extend the app's proven *stable-key* philosophy (junctions,
elements, sections all key their overrides parametrically) **down to the
vertex level**. Every derived polygon ships a parallel array of stable vertex
keys; one generic override store lets the user nudge any keyed vertex; the
override is re-applied by key on every regeneration, in the local
tangent/normal frame, so it rides node drags and width edits and goes *stale*
(dropped) rather than *wrong* when its anchor disappears.

This single substrate answers three questions at once: where overrides live,
how geometry exposes editable points, and how the canvas renders handles.

---

## 1. Why world-space deltas are wrong

Every vertex in this codebase is produced as **centerline-point +
normal·offset** (`geometry/polyline.ts:pointAtStation`, `ribbonBand`,
`offsetPolyline`; `sections/transition.ts:sampleTransitionBands`;
`graph/junctions.ts` ring assembly). If a vertex override stored a world
`{dx, dy}`, dragging a node or reversing a street would leave the nudge
pointing the wrong way.

So an override stores a **parametric offset in the local frame**:

```ts
interface VertexOffset { dAlong: number; dAcross: number } // metres, tangent/normal at the vertex station
```

Re-applied as `p + tangent·dAlong + normal·dAcross`, it rides the alignment
exactly the way `refM` and element anchors already do.

## 2. The stable vertex-key scheme

Keys must identify a vertex by **identity**, never by array position — sample
counts change with radius, zone length, and simplification. Per shape family:

| shape | key |
|---|---|
| ribbon band vertex | `${edgeId}/${compIndex}/${side:up\|lo}/${arcLenFraction}` |
| junction mouth cap | `${approachKey}/${L\|R}` (reuse `ApproachInfo.key`) |
| fillet-arc vertex | `${cornerKey}/${arcAngleFraction}` (reuse `CornerInfo.key`) |
| wedge vertex | `${cornerKey}/${matchedCompIndex}/${stationFraction}` |
| patch vertex | `${patchId}/${index}` (patches are already stored — trivial) |

Fraction-based keys (arc-length or angle in `[0,1]`) survive resampling: on
regeneration, find the emitted vertex whose fraction is closest to the stored
key within a small tolerance and apply the offset there.

**Failure modes to design against** (the assessment flagged these):
1. Topology change removes the edge/node → key vanishes → override dropped. Safe.
2. **Silent mis-application** — a key survives but its meaning shifted. This is
   the real hazard; it is why keys are fraction/identity based, not index based.
3. A corner flips fillet↔chamfer (`solveCorner`) → the whole vertex population
   changes → arc overrides must be scoped to `radiusM !== null` and dropped otherwise.

A `pruneVertexOverrides(g, artifacts)` boundary function drops keys with no
matching emitted vertex, mirroring the existing `pruneElements`/`pruneSelections`.

## 3. What already exists to reuse

Do not reinvent: junction key (sorted node ids), `approachKey`
(`${edgeId}:${end}`), `cornerKey` (`${approachKeyA}|${approachKeyB}`), element
anchors `(edgeId, stationM, compIndex, t)`, and the `key` fields already on
`RibbonBand`, `RibbonMarking`, `CornerInfo`, `ApproachInfo`. Edge-id + station
is the app's universal parametric coordinate. The store's pause/resume
one-undo-step gesture discipline and `partialize`/`equality`/`pruneSelections`
plumbing take a `vertexOverrides` slice with no new machinery.

## 4. Where keyed vertices get emitted

Two chokepoints produce most vertices:
- `geometry/ribbon.ts:buildRibbon` → `ribbonBand`/`offsetPolyline` (constant spans)
- `sections/transition.ts:sampleTransitionBands` (transition spans, node
  transitions, **and** junction wedges — shared)

Plus inline geometry in `graph/junctions.ts:computeJunction` (the ring) and
`solveCorner` (the arc), and `detailing/elements.ts:elementGraphics`.

**Plan:** give `RibbonBand` an optional `vertexKeys?: string[]` parallel to
`polygon`. Both chokepoints already iterate samples/components in order, so
emitting keys is a local change. The junction ring is the messiest (it
concatenates reversed curb segments + arc + neighbour segments inline) and
likely wants a small `ringVertex(kind, key)` helper. **Do not** recompute keys
separately and match by proximity — that duplicates ordering logic and
reintroduces the drift bug the keys exist to prevent.

## 5. The generic handle layer (highest-leverage UI refactor)

Today there are five bespoke drag handlers with duplicated boilerplate
(`NodesLayer`, `VerticesLayer`, `JunctionHandlesLayer`, `PatchesLayer`
vertices, `ElementShape`), each repeating `temporal.pause/resume`,
`stageToWorld`, the `setAttr('dragFrom')` baseline hack, right-click delete,
and `hoverCursor`.

Replace with **one `<HandleLayer handles={Handle[]} />` + a `useHandleDrag`
hook**:

```ts
interface Handle {
  id: string;
  x: number; y: number;
  style: 'point' | 'radius' | 'trim';
  axis?: { x: number; y: number };   // constrained drags (corner radius, approach trim)
  snap?: boolean;
  onDrag: (world: { x: number; y: number } | number) => void;
  onCommit?: () => void;
  onRemove?: () => void;
}
```

The hook owns pause/resume, world conversion, the `dragFrom` baseline, axis
projection, snapping, and post-drag position reset. Corner/trim handles are
`axis`-constrained; node, patch, ribbon-vertex, and element handles are free.
Every existing handler collapses into a list of `Handle`s.

## 6. Foundational vs nice-to-have (CAD table stakes)

**Foundational — build before per-vertex editing:**
- **Spatial index** (uniform grid or quadtree, rebuilt per graph snapshot).
  `findSnap` (`CanvasStage.tsx`) and `resolveDrop` (`elements.ts`) are O(edges)
  linear scans, fine only to ~200 edges. Per-vertex editing multiplies query
  volume; this is a prerequisite, not polish.
- **Unified snapping service** over the index: grid + endpoint + vertex + edge +
  the new keyed vertices. Today only the draw tool snaps, only to node/edge.
- **Measurement / coordinate readout** — nearly free (the coords pill exists),
  high value: live segment length + dimension annotations.

**Nice-to-have / deferrable:**
- Alignment guides (fall out of the spatial index).
- Copy/paste, grouping (mostly a patch-stage concern).
- **Constraints / parametric dimensions** — heaviest, and the *worst* fit for a
  regenerate-every-frame model. Persistent constraints imply stored geometry:
  they belong to `Patch` or a future dedicated constraint layer, never to the
  derived ribbons.

## 7. Build order for the CAD layer

1. **Spatial index + unified snapping service** (foundational; also speeds
   existing draw/detailing).
2. **`HandleLayer` + `useHandleDrag`** — refactor the five existing handlers
   onto it (pure structure, no behaviour change; lock with the existing drives).
3. **Keyed-vertex contract** — `vertexKeys` on `RibbonBand`, ring, arc, wedge.
4. **`vertexOverrides` store slice** + parametric re-application + `pruneVertexOverrides`.
5. **Vertex editing UX** — Direct tool grabs any keyed vertex on any derived
   shape; a "reset vertex/shape" affordance; stale-override list like junctions.
6. **Measurement + dimension tools** on the snapping service.

Steps 1–2 are safe refactors that pay off immediately. Steps 3–5 are the CAD
payload and should land behind the keyed-vertex contract so every shape —
including ones not yet built — becomes editable through the same mechanism.
