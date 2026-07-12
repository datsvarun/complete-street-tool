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
| Floating map-app UI, top toolbar, Direct tool, marquee/lasso | **shipped** |
| Bbox OSM import, export extent | **shipped** |
| vitest engine suite (14 tests) | **shipped** |
| **Persistence** (save/open/autosave) | **not started** — biggest product gap |
| **CAD node-editing of derived geometry** | **not started** — see `CAD_Architecture.md` |
| Junctions J5–J7 (templates, roundabout, probe/validation) | **not started** |
| Detailing depth (element properties, signs, signals) | **partial** |

The app is a coherent end-to-end pipeline. The two highest-value next
investments are **persistence** (a refresh currently loses everything) and the
**CAD keyed-vertex layer** (the user's node-based-control ask).

---

## 2. Prioritized work (each item is one shippable slice)

Ordered by leverage. Do them top-down unless a specific need reorders them.

### P0 — Persistence MVP  *(small, protects all future work)*
Currently client-only with no save. The undoable slice is already exactly the
serializable document.
- Autosave the undoable slice to `localStorage` (debounced); restore on load.
- Save / Open `.cst.json` (schema = graph + origin + junctionDesigns +
  elements + patches + version). Version the schema from day one.
- "New / clear" with confirm.
- **Done-when:** draw → refresh → design intact; save file → reopen → identical.
- *Files:* new `store` actions `serialize`/`load`/`clear`; a small
  `persistence.ts`; hook autosave in `store.ts`; buttons in the header.

### P1 — CAD foundation: spatial index + unified snapping  *(unblocks CAD + scale)*
See `CAD_Architecture.md` §6. `findSnap`/`resolveDrop` are O(edges) scans.
- Uniform-grid or quadtree index rebuilt per graph snapshot.
- Snapping service: grid + endpoint + vertex + edge, shared by all tools.
- **Done-when:** 1000-edge import stays smooth on node drag/draw; draw snaps to
  vertices and edges, not just nodes.

### P2 — CAD: generic handle layer  *(pure refactor, big payoff)*
`CAD_Architecture.md` §5. Collapse the five bespoke drag handlers
(`NodesLayer`, `VerticesLayer`, `JunctionHandlesLayer`, `PatchesLayer`
vertices, `ElementShape`) into one `<HandleLayer>` + `useHandleDrag`.
- **Done-when:** no behaviour change; existing Playwright drives still green;
  the `setAttr('dragFrom')` debt (ARCHITECTURE §11.7) is gone.

### P3 — CAD: keyed-vertex overrides  *(the node-based-control ask)*
`CAD_Architecture.md` §2–4. `vertexKeys` on derived polygons; a
`vertexOverrides` store slice applied in the local frame; `pruneVertexOverrides`;
Direct tool grabs any vertex of any generated shape.
- **Done-when:** drag a ribbon-band vertex or a fillet-arc vertex, edit the
  graph, and the nudge rides along; deleting the edge drops the override.

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

_To be completed with the current review pass — contained bugs fixed in the
accompanying commit, larger ones filed here with file:line and repro._

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
