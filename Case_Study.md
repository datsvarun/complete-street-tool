# Case Study: osm2streets, Streetmix, 3DStreet, LaneMaker

A focused evaluation of what to borrow, what to leave, and why — based on reading the actual source code, not documentation or demos.

**Purpose:** This document is a working reference for building the IRC-compliant street designer. Each section ends with concrete borrow/don't-borrow calls and, where relevant, ported-to-TypeScript pseudocode of the algorithm worth stealing.

**Scope check:** I read enough of each codebase to answer the brief — core geometry, data model, key interactions, and rendering. I did not read every file. The findings that matter — especially the algorithms in §1 and §4 — are supported by specific line-referenced reads.

---

## 1. osm2streets

**What it is:** A Rust library that turns OSM XML into a cleaned-up street network with lane-level geometry and intersection polygons. WASM bindings for use in the browser. Used by A/B Street for traffic simulation.

**Honest read on "use osm2streets directly":** The Overpass downloader is 60 lines of Svelte and worth copying verbatim. The rendering layer is GeoJSON + MapLibre match expressions — dead simple, also worth copying. The core geometry logic (`intersection_polygon` and friends) is ~500 lines of Rust that **ports cleanly to TypeScript** — we don't need the WASM dependency. The dual-carriageway merging is WIP and not ready to copy. The lane-type enum is US/UK-centric and doesn't map cleanly to IRC components.

### 1.1 Domain model — port one-to-one

```ts
interface StreetNetwork {
  roads: Map<RoadID, Road>;
  intersections: Map<IntersectionID, Intersection>;
  gpsBounds: GpsBounds;
  boundaryPolygon: Polygon;
}

interface Road {
  id: RoadID;
  srcIntersection: IntersectionID;
  dstIntersection: IntersectionID;
  referenceLine: PolyLine;      // frozen, from OSM
  trimStart: number;            // metres, recomputed
  trimEnd: number;              // metres, recomputed
  get centerLine(): PolyLine;   // = reference, trimmed on both ends
  totalWidth: number;
  // ...
}

interface Intersection {
  id: IntersectionID;
  roads: RoadID[];              // sorted CLOCKWISE — critical invariant
  polygon: Polygon;             // recomputed
  kind: 'Terminus' | 'Intersection' | 'MapEdge';
  // ...
}
```

**Why this is the right model:**

- Trim distances are **numbers**, not pre-trimmed polylines. The center line is a derived getter that re-cuts the reference line each time. This makes every edit idempotent — recompute from scratch, same result every time. No stale state, no "did I already trim this?" bugs.
- Intersections own the **sorted clockwise** road list as an invariant. All geometry algorithms rely on this ordering; if you ever let it go out of sync, everything breaks silently.
- Numeric IDs in BTreeMaps (ordered maps). Deterministic iteration. Snapshottable by value.

Ref: `osm2streets/src/lib.rs` lines 46–68 for `StreetNetwork`; `road.rs` for `Road`; `update_geometry.rs` for the idempotent recompute pattern.

### 1.2 Intersection polygon algorithm — the core thing to port

`intersection_polygon()` in `geometry/mod.rs` dispatches by road count:

| Roads | Handler | Strategy |
|---|---|---|
| 1 | `terminus` | Square cap at the end of the road |
| 2 | `degenerate` | Trim both back 1m, build a quad |
| 3+ | `general_case::trim_to_corners` | Edge-intersection + perpendicular projection |
| Merging | `pretrimmed` | Special: uses pre-computed trim points |

**The general case is the algorithm worth studying.** Ported to TypeScript pseudocode:

```ts
function intersectionPolygonGeneralCase(
  intersectionId: IntersectionID,
  roads: InputRoad[],       // already sorted clockwise
): { polygon: Polygon; trimsByRoad: Map<RoadID, { start: number; end: number }> } {

  // Compute edges (left + right polylines) for each road
  const edges = roads.flatMap(r => [
    { road: r.id, side: 'left',  pl: r.centerLine.shiftLeft(r.halfWidth) },
    { road: r.id, side: 'right', pl: r.centerLine.shiftRight(r.halfWidth) },
  ]);
  // Walk pairwise, wrap around
  const wrapped = [...edges, edges[0]];

  const origCenters = new Map(roads.map(r => [r.id, r.centerLine.clone()]));
  const workingCenters = new Map(roads.map(r => [r.id, r.centerLine.clone()]));

  for (let i = 0; i < wrapped.length - 1; i++) {
    const one = wrapped[i], two = wrapped[i + 1];
    if (one.road === two.road) continue;  // skip self-pair

    // Find where the two edges collide, closest to intersection
    // (reverse both so .intersection() returns the far end = the intersection side)
    const hit = one.pl.reversed().intersection(two.pl.reversed());
    if (!hit) continue;

    // For each of the two roads: project collision perpendicular onto its center,
    // then trim the center back to that point
    for (const side of [one, two]) {
      const { dist, angle } = side.pl.distAlongOfPoint(hit);
      const perp = InfiniteLine.fromPointAndAngle(hit, angle + 90);

      // Center line pointing AWAY from the intersection (so first hit is nearest)
      let centerAway = origCenters.get(side.road)!.clone();
      if (roadPointsIntoIntersection(side.road, intersectionId)) {
        centerAway = centerAway.reversed();
      }

      const hits = centerAway.allIntersectionsWithInfiniteLine(perp);
      const trimmedCandidates = hits.map(h => centerAway.sliceStartingAt(h));

      // Pick the candidate with MAXIMUM length (= minimum trim = closest to intersection)
      const best = trimmedCandidates.reduce((a, b) => a.length > b.length ? a : b);

      if (best.length < workingCenters.get(side.road)!.length) {
        workingCenters.set(side.road, best.reversedIfNeeded());
      }
    }
  }

  // Build polygon by walking edges, adding (a) each edge endpoint and (b) original collision corners
  const polygonPoints: Point[] = [];
  for (let i = 0; i < wrapped.length - 1; i++) {
    const one = wrapped[i], two = wrapped[i + 1];
    polygonPoints.push(one.pl.lastPoint);
    if (one.road !== two.road) {
      const corner = extendToOriginalLength(one.pl).reversed()
        .intersection(extendToOriginalLength(two.pl).reversed());
      if (corner) polygonPoints.push(corner);
    }
  }

  return { polygon: Polygon.fromRing(polygonPoints), trimsByRoad: /* ... */ };
}
```

**Why this is clever:** The key insight is *projecting the edge-collision perpendicular back onto the centerline*. Naive approaches find where edges meet and trim to the nearest point, but that produces skewed cuts on curved or angled roads. Perpendicular projection ensures the trimmed end is square to the road's direction, which is what every subsequent operation (cross-section rendering, crossing placement, curb radii) expects.

The "pick maximum length" on candidates handles roads with multiple self-intersecting perpendicular projections — a degenerate case you don't notice until real data hits it.

Ref: `osm2streets/src/geometry/general_case.rs` lines 11–128; `polygon_from_corners` in `geometry/mod.rs` lines 172–229.

### 1.3 Degenerate (2-road) handler — port verbatim

For roads meeting at a node with no other connections, just trim each back 1m and build a quad from the four corner points.

```ts
function intersectionPolygonDegenerate(road1: InputRoad, road2: InputRoad, intersectionId: IntersectionID): Polygon {
  const idealTrim = 1.0;   // metres
  const minTrim = 0.1;

  const trim = (c: PolyLine) =>
    c.length > 2 * idealTrim ? c.slice(0, c.length - idealTrim) : c.slice(0, c.length - minTrim);

  const c1 = trim(road1.centerLinePointedAt(intersectionId));
  const c2 = trim(road2.centerLinePointedAt(intersectionId));

  return Polygon.fromRing([
    c1.shiftLeft(road1.halfWidth).lastPoint,
    c2.shiftRight(road2.halfWidth).lastPoint,
    c2.shiftLeft(road2.halfWidth).lastPoint,
    c1.shiftRight(road1.halfWidth).lastPoint,
  ]);
}
```

Ref: `osm2streets/src/geometry/degenerate.rs`.

### 1.4 Terminus handler

Simplest case. Cap the road at its dead end with a square.

Ref: `osm2streets/src/geometry/terminus.rs`.

### 1.5 Transform pipeline — pattern to adopt

osm2streets models network cleanup as an ordered list of idempotent, pure transforms:

```ts
enum Transformation {
  RemoveDisconnectedRoads,
  CollapseShortRoads,           // "internal junction roads"
  CollapseDegenerateIntersections,
  // ...
}

function standardPipeline(): Transformation[] {
  return [
    Transformation.CollapseShortRoads,
    Transformation.CollapseDegenerateIntersections,
    // First pass may create new opportunities for the first
    Transformation.CollapseShortRoads,
  ];
}
```

Three rules the pattern enforces:

1. Each transform is a pure function on `StreetNetwork`. No external state.
2. Transforms can be composed in any order (for debugging) but the *standard* pipeline has an explicit re-ordering (step 1 appears twice).
3. Every transform snapshots the network before it runs (if debug mode is on), so the whole history is visible post-hoc.

**Adopt verbatim.** This pattern is how we'll structure: OSM import → ROW assignment from highway tags → cross-section application → junction generation → validation. Each a transform. Each snapshottable.

Ref: `osm2streets/src/transform/mod.rs`.

### 1.6 Debug snapshot pattern

```ts
interface DebugStep {
  label: string;
  networkSnapshot: StreetNetwork;
  points: Array<{ pt: Point; label: string }>;
  polylines: Array<{ pl: PolyLine; label: string }>;
}
```

Every `update_geometry()` call can optionally push debug points labeled with what's happening ("trim candidate for road 5", "corner hit here"). In debug mode, the UI shows a slider to scrub through steps. **Priceless for our junction editor** — users will ask "why does this junction look weird" and we'll have a direct answer.

Ref: `osm2streets/src/lib.rs` lines 70–80 and 151–197.

### 1.7 Overpass downloader — copy directly

```ts
function overpassQueryForPolygon(feature: GeoJSONPolygon): string {
  const coords = feature.geometry.coordinates[0];
  const polyFilter = coords.map(([lng, lat]) => `${lat} ${lng}`).join(' ');
  const query = `(nwr(poly:"${polyFilter}"); node(w)->.x; <;); out meta;`;
  return `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
}

// UX: require min zoom 15 before allowing import
if (map.getZoom() < 15) throw new Error('Zoom in more or draw a custom area');
```

The Overpass QL: `nwr(poly:...)` gets all nodes/ways/relations in the polygon; `node(w)->.x; <;` recursively grabs parent relations and referenced nodes. `out meta` includes OSM IDs and versions.

Ref: `osm2streets/web/src/common/osm_input/OverpassSelector.svelte` lines 52–60.

### 1.8 Rendering — copy the approach

They don't render with custom WebGL. They emit GeoJSON with a `type` property per feature, then use a MapLibre match expression to color fills:

```ts
// Core output
network.toLanePolygonsGeoJSON() // → FeatureCollection with feature.properties.type

// MapLibre style
{
  'fill-color': ['match', ['get', 'type'],
    'Driving',   '#333',
    'Sidewalk',  '#CCC',
    'Biking',    '#0F7D4B',
    'Bus',       '#BE4A4C',
    '#FF0000', // fallback
  ],
  'fill-opacity': 0.9,
}
```

**This is exactly our schematic rendering.** No textures, no tree shadows, just colored polygons with a legend. Maps 1:1 to how we'll render IRC components (Carriageway, Footpath, Cycle Track, MFZ, MUZ, Buffer, Median, etc.).

Ref: `osm2streets/web/src/common/layers/RenderLanePolygons.svelte`.

### 1.9 osm2streets — borrow/don't-borrow summary

| Borrow | Don't borrow |
|---|---|
| `StreetNetwork` domain model | WASM dependency (port to TS instead) |
| Trim-distances-not-polylines pattern | Dual-carriageway merging (WIP) |
| Clockwise-sorted road invariant | `LaneType` enum (US/UK-centric) |
| 4-case intersection polygon dispatch | `osm2lanes` lane inference for IRC |
| Transform pipeline + snapshot model | |
| Overpass downloader + min-zoom UX | |
| GeoJSON + MapLibre schematic rendering | |

---

## 2. Streetmix

**What it is:** A React/Redux web app for designing street cross-sections. The user picks segments (drive lane, bike lane, sidewalk, parking...) from a palette, drags them into a horizontal strip, resizes each. Output is an illustration.

**Honest read on "use Streetmix directly":** Streetmix has no concept of plan geometry. Everything is a 1D strip. You cannot borrow junction logic from it because there is none. What's worth taking is UX patterns around cross-section editing and the discipline of citable numeric data.

### 2.1 Resolution-per-interaction — pattern to steal

```ts
const SEGMENT_WIDTH_RESOLUTION_METRIC          = 0.05; // typing, initial load
const SEGMENT_WIDTH_CLICK_INCREMENT_METRIC     = 0.1;  // +/- button clicks
const SEGMENT_WIDTH_DRAGGING_RESOLUTION_METRIC = 0.1;  // mouse drag
// ALT-drag uses the typing resolution (0.05) for precise placement

function normalizeSegmentWidth(width: number, resolution: number): number {
  width = clamp(width, MIN_SEGMENT_WIDTH, MAX_SEGMENT_WIDTH);
  width = Math.round(width / resolution) * resolution;
  return round(width, 3);  // eliminate float crud
}
```

Why this is smart: drag events fire at 60Hz; snapping to 0.1m gives the user haptic feedback every 10cm without jittering. Typed input snaps finer (0.05m) because the user explicitly wants precision. **Adopt the exact pattern** — apply to section width, junction corner radius, crossing offset, splitter length.

Ref: `streetmix/client/src/segments/constants.ts` lines 27–29; `resizing.ts` lines 187–224.

### 2.2 Citable numeric data

Streetmix's `capacity_data.json` has per-segment-type capacity ranges with source attribution (GIZ, NACTO). Structure:

```json
{
  "giz": {
    "source_title": "Passenger capacity of different transport modes",
    "source_author": "Transformative Urban Mobility Initiative",
    "source_url": "https://...",
    "segments": {
      "drive-lane": { "average": 1500, "potential": 2000 },
      "bike-lane":  { "average": 12000, "potential": 12000 }
    }
  }
}
```

**Directly applicable.** For our tool, the same structure holds IRC-derived compliance rules:

```json
{
  "irc-sp-118-2018": {
    "source_title": "Manual for Planning and Development of Urban Roads and Streets",
    "source_author": "Indian Roads Congress",
    "source_url": "https://...",
    "rules": {
      "footpath_min_width": 1.5,
      "cycle_track_min_width": 2.0,
      "carriageway_lane_width": { "min": 3.0, "preferred": 3.5 },
      ...
    }
  }
}
```

Every rule cites its source. Validator output can say "per IRC SP:118-2018, footpath should be ≥1.5m (current: 1.2m)" — not just "invalid".

### 2.3 Warnings as flags, not blockers

Each segment carries an array of warning flags (outside street bounds, width too small, width too large). The user can always exceed them; the UI just colors the segment differently and shows a tooltip. **Adopt.** Our compliance validator should do exactly this.

Ref: `streetmix/client/src/segments/constants.ts` lines 15–21.

### 2.4 Component composition vs monolithic segments

Streetmix's newer schema defines segments as assemblies of components:

- **Component types:** `lane`, `vehicle`, `object`, `marking`
- **Lane:** ground-level zone with fixed width, intent, desired speed
- **Vehicle:** mode of transport (car, bike, bus...), can travel in a direction
- **Object:** furniture (benches, trees, signs)
- **Marking:** transitional category (lane stripes)

A segment is then a recipe: `{ lane: 'drive', vehicles: ['car'], markings: [...] }`.

**Applicable to us with one change:** IRC JSON already gives us a flat component list per cross-section. We don't need the recipe abstraction — our "components" are already the atomic units (Footpath, Carriageway, MFZ, etc.). Don't over-model.

Ref: [Streetmix docs on segment definitions](https://streetmix.readthedocs.io/en/latest/technical/segment-definitions/); `streetmix/packages/parts/src/components.json`.

### 2.5 Streetmix — borrow/don't-borrow summary

| Borrow | Don't borrow |
|---|---|
| Resolution-per-interaction-type | The sprite/illustration system |
| Citable data pattern (source attribution) | The variant explosion |
| Warnings-as-flags, non-blocking | Redux-based undo (use Zustand + temporal) |
| Component composition (lightly) | The 1D-strip assumption everywhere |

---

## 3. 3DStreet

**What it is:** An A-Frame/Three.js web app that converts Streetmix cross-sections into 3D scenes. Procedurally extrudes the 1D strip along a straight axis and places 3D models (cars, trees, signs) on it.

**Honest read:** 3DStreet is a 2D-to-3D extruder. It inherits all of Streetmix's limitations (no plan geometry, no junctions) and adds a 3D dependency we don't need. Most of its code is A-Frame entity plumbing that doesn't port. Three small patterns are worth stealing.

### 3.1 Separator segment insertion — port directly

```ts
function insertSeparatorSegments(components: Component[]): Component[] {
  function isLaneIsh(element: string): boolean {
    return ['Carriageway', 'Mixed traffic lane', 'Cycle Track', 'Service Lane',
            'Bus Rapid Transit Corridor'].includes(element);
  }

  const result: Component[] = [];
  for (let i = 0; i < components.length; i++) {
    const current = components[i];
    if (i > 0) {
      const prev = components[i - 1];
      if (isLaneIsh(prev.element) && isLaneIsh(current.element)) {
        // Same type → dashed (lane marking); different type → solid (edge line)
        const markingType = (prev.element === current.element) ? 'dashed' : 'solid';
        result.push({ element: `LaneMarking:${markingType}`, width: 0 });
      }
    }
    result.push(current);
  }
  return result;
}
```

This inserts 0-width marking elements into the component list wherever two drivable lanes are adjacent. **Directly applicable** to our IRC cross-sections. E.g., between two Carriageway components in the 24m symmetric variant, we auto-insert a dashed lane marking; between a Carriageway and a Median, we auto-insert a solid edge line.

Ref: `3dstreet/src/aframe-streetmix-parsers.js` lines 51–100.

### 3.2 Cumulative offset positioning

```ts
let cumulative = 0;
for (const component of components) {
  const centerX = cumulative + component.width / 2;
  renderComponent(component, centerX);
  cumulative += component.width;
}
```

Obvious but worth making explicit. The component center, not its edge, is what you position at — every downstream calculation (where to place markings, where to put tree pits) is easier when you track centers.

Ref: `3dstreet/src/aframe-streetmix-parsers.js` lines 1014–1023.

### 3.3 Elevation via quantized curb heights

```ts
const CURB_HEIGHT = 0.15;  // metres, one standard curb
// Elevation levels are integers: 0 = grade, 1 = curb (0.15m), 2 = raised (0.30m), -1 = sunken, ...
const elevationY = elevationLevel * CURB_HEIGHT;
```

Useful when we eventually render raised cycle tracks or footpath levels in our 2D view with subtle shading. Integer levels × 0.15m is the clean way to do it; avoid free-form elevation values that cause drift.

Ref: `3dstreet/src/aframe-streetmix-parsers.js` lines 1036–1041.

### 3.4 3DStreet — borrow/don't-borrow summary

| Borrow | Don't borrow |
|---|---|
| `insertSeparatorSegments` pattern | A-Frame / entity-DOM model |
| Cumulative offset positioning | 3D model / glTF pipeline |
| Quantized elevation (levels × curb height) | Everything else |

---

## 4. LaneMaker

**What it is:** A Qt/C++ desktop app for authoring lane-accurate road networks with OpenDRIVE export. Uses CGAL for exact geometry. The junction modeling is by far the most sophisticated of the four.

**Honest read:** Cannot be borrowed as code — it's C++ with CGAL. But four algorithms are worth reimplementing, and the domain model around `ConnectionInfo`/`TurningGroup` is the best of any of the four projects.

### 4.1 Turn semantics classification — port in 10 lines

```ts
enum TurnSemantic { Straight, Left, Right, UTurn, DeadEnd }

function classifyTurn(fromHeading: number, toHeading: number): TurnSemantic {
  const delta = normalizeAngle(toHeading - fromHeading);  // in radians, [-π, π]
  if (Math.abs(delta) > Math.PI - 0.1) return TurnSemantic.UTurn;
  if (delta >  Math.PI / 4) return TurnSemantic.Left;
  if (delta < -Math.PI / 4) return TurnSemantic.Right;
  return TurnSemantic.Straight;
}
```

That's it. Compare heading at the start of the connecting road vs the end. `|delta| > π - 0.1` (≥170°) is a U-turn; `delta > π/4` (>45°) is a left turn (in right-hand-drive convention — flip for left-hand-drive India); else straight.

**Why port this:** Every movement in a junction needs a semantic classification — for rendering turn arrows, validating OSM `turn=*` tags, filtering allowed movements, and later generating signal phases. This is the atomic operation.

Ref: `lanemaker/xodr/junction.cpp` lines 424–461.

### 4.2 Probe-based junction boundary — for complex junctions

For junctions with 5+ approaches at varying widths (common in Indian cities), osm2streets' corner-fillet approach produces bad polygons. LaneMaker's approach:

```
1. Sort approaches clockwise around the junction center.
2. For each adjacent pair (A, B):
   a. Take the "outer corner" points of A and B (far edge ends facing B / A respectively).
   b. Walk the chord between those two corners.
   c. At N points along the chord (one per metre), cast a perpendicular probe line.
   d. For each probe, find the FARTHEST intersection with any connecting-road boundary
      inside the junction. That point is the junction's outer edge at that probe.
   e. The probe points form the arc between A's corner and B's corner.
3. Union all arcs → junction polygon.
```

Ported pseudocode (simplified from `junction_boundary.cpp`):

```ts
function junctionBoundaryViaProbes(
  approaches: ConnectionInfo[],  // sorted clockwise
  connectingRoads: ConnectingRoad[],
): Polygon {
  const boundary: Point[] = [];

  for (let i = 0; i < approaches.length; i++) {
    const a = approaches[i];
    const b = approaches[(i + 1) % approaches.length];

    const cornerA = outerCornerOf(a, 'toward-b');
    const cornerB = outerCornerOf(b, 'toward-a');

    boundary.push(cornerA);

    const chordDist = distance(cornerA, cornerB);
    const chordDir = normalize(subtract(cornerB, cornerA));
    const outward = { x: chordDir.y, y: -chordDir.x };  // perpendicular, outward
    const nProbes = Math.ceil(chordDist);

    for (let j = 1; j <= nProbes; j++) {
      const t = j / (nProbes + 1);
      const probePoint = lerp(cornerA, cornerB, t);
      const probeLine = InfiniteLine.fromPointAndDirection(probePoint, outward);

      let farthestDist = -Infinity;
      let farthestPoint = probePoint;
      for (const cr of connectingRoads) {
        for (const side of ['left', 'right'] as const) {
          const boundary = cr.getBoundary(side);
          const hit = boundary.intersection(probeLine);
          if (hit) {
            const d = signedDistance(hit, probePoint, outward);
            if (d > farthestDist) {
              farthestDist = d;
              farthestPoint = hit;
            }
          }
        }
      }
      boundary.push(farthestPoint);
    }
  }

  return Polygon.fromRing(boundary);
}
```

**When to use which:** Simple junctions (≤4 approaches, roughly orthogonal) → osm2streets corner-fillet. Complex junctions (5+ approaches, asymmetric widths, islands between pairs) → LaneMaker probes. A heuristic: if the clockwise heading delta between any two adjacent approaches is less than 30° OR more than one approach is on the same arterial at a split, use the probe method.

Ref: `lanemaker/xodr/junction_boundary.cpp` lines 61–250.

### 4.3 Conflict-graph signal phasing

```ts
function generateSignalPhases(connectingRoads: ConnectingRoad[]): ConnectingRoad[][] {
  const conflictCache = new Map<string, boolean>();
  const conflict = (a: ConnectingRoad, b: ConnectingRoad) =>
    memoized(conflictCache, `${a.id}:${b.id}`, () => connectingRoadsConflict(a, b));

  // Sort by lane count descending — bigger flows get their own phase first
  const pending = [...connectingRoads].sort((a, b) => b.laneCount - a.laneCount);
  const phases: ConnectingRoad[][] = [];

  while (pending.length > 0) {
    const seed = pending.shift()!;
    const phase = [seed];

    // Greedily add every road that (a) shares an origin lane with phase members
    // (parallel flows are free) OR (b) doesn't conflict with any phase member
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const candidate = pending[i];
        const sharesOrigin = phase.some(p => sharesIncomingLane(p, candidate));
        const hasConflict  = phase.some(p => conflict(p, candidate));
        if (sharesOrigin || !hasConflict) {
          phase.push(candidate);
          pending.splice(i, 1);
          changed = true;
        }
      }
    }
    phases.push(phase);
  }

  return phases;
}

function connectingRoadsConflict(a: ConnectingRoad, b: ConnectingRoad): boolean {
  // Same destination + same destination lane → conflict (merging into same spot)
  if (a.to === b.to && sharesDestinationLane(a, b)) return true;

  // Same origin + different destination → NOT a conflict (parallel from same approach)
  if (a.from === b.from) return false;

  // Otherwise: geometric test — do the connecting road polygons intersect?
  return a.polygon.intersects(b.polygon);
}
```

Classic greedy graph coloring. **Useful for us** for generating a default signal plan when the user designates a junction as signalized — even for schematic output, showing "Phase 1: N-S through + N-S right, Phase 2: E-W through + E-W right, Phase 3: all lefts" is a publishable-quality insight.

Ref: `lanemaker/xodr/junction.cpp` lines 463–560; `junction_generation.cpp` lines 620–676.

### 4.4 ConnectRays — curve fitting between two rays

Given `(startPos, startHeading)` and `(endPos, endHeading)`, fit a smooth curve:

```
1. If p2 lies on the ray from p1 in direction startHdg
   AND p1 lies on the ray from p2 in direction -endHdg:
     → collinear, use a straight Line.
2. If the rays converge (intersect in front of both starts):
     → fit a cubic Bezier with the intersection point as both middle control points.
3. If rays diverge or the intersection is too far:
     → fit a clothoid (Euler spiral, linear curvature change).
4. If nothing else works:
     → fit a general ParamPoly3 (cubic polynomial).
```

**For our schematic 2D tool, case 2 is what matters** — we're not doing design-speed geometry. A cubic Bezier with matched tangents produces a clean S-curve for channelized turns, splitter island noses, slip lane geometry, and curb radii beyond simple arcs.

```ts
function fitCubicBezier(startPos: Point, startHdg: Vec2, endPos: Point, endHdg: Vec2): CubicBezier {
  const rayStart = Ray.from(startPos, startHdg);
  const rayEnd   = Ray.from(endPos, scale(endHdg, -1));
  const intersection = rayStart.intersection(rayEnd);

  if (!intersection) {
    // Parallel — fall back to straight
    throw new Error('Parallel rays, use line');
  }

  // Both middle control points at the intersection
  return new CubicBezier([startPos, intersection, intersection, endPos]);
}
```

Ref: `lanemaker/xodr/curve_fitting.cpp` lines 31–100.

### 4.5 Domain model — the parts worth lifting

```ts
interface ConnectionInfo {
  roadId: RoadID;
  contact: 'Start' | 'End';        // which end of the road meets the junction
  leftProfile: LanePlan;            // lanes on the left at that end
  rightProfile: LanePlan;
  refLinePos: Point;                // where the road's reference line meets the junction
  refLineHdg: number;               // heading into the junction
}

interface TurningGroup {
  from: { roadId: RoadID; contact: 'Start' | 'End'; laneBase: number; laneCount: number; origin: Point; forward: Vec2 };
  to:   { roadId: RoadID; contact: 'Start' | 'End'; laneBase: number; laneCount: number; origin: Point; forward: Vec2 };
  semantic: TurnSemantic;
  // A turning group is a RANGE of lanes turning together (e.g., "lanes 3-4 turn left")
}
```

**The key insight:** A movement through a junction is defined by a `TurningGroup` — a *range* of lanes going together, not individual lanes. If 3 lanes go straight, that's one TurningGroup with `laneCount: 3`. If a turn lane peels off, that's a separate TurningGroup with its own lane range. This is the right granularity for Indian junctions where you rarely have per-lane turn restrictions but often have "rightmost two lanes turn right."

**Port the concept, not the C++.** Our version will be simpler — we don't need OpenDRIVE's lane-link objects — but the *range-not-single-lane* idea is load-bearing.

Ref: `lanemaker/xodr/junction.h` lines 18–129.

### 4.6 LaneMaker — borrow/don't-borrow summary

| Borrow (reimplement) | Don't borrow |
|---|---|
| Turn classification (heading delta) | C++ / CGAL |
| Probe-based junction boundary | OpenDRIVE export |
| Conflict-graph signal phases | The full AbstractJunction hierarchy |
| Cubic-Bezier ray connection | Per-lane numeric IDs |
| `ConnectionInfo` + `TurningGroup` data model | Clothoid fitting (we're schematic) |

---

## 5. Consolidated: the algorithm & code we're actually porting

To make the "borrow" decisions unambiguous, here's a single list of what gets ported and roughly how much work each is.

| Item | From | LOC (TS, est.) | Phase |
|---|---|---|---|
| Overpass downloader + bbox UI | osm2streets | ~80 | Phase 1 |
| `StreetNetwork` domain model | osm2streets | ~200 | Phase 1 |
| `PolyLine` with `shiftLeft/Right`, `intersection`, `sliceStartingAt`, `extendToLength` | osm2streets (via `geom` crate) | ~400 | Phase 1 |
| Split ways → roads + intersections | osm2streets/streets_reader | ~150 | Phase 1 |
| `collapse_short_road` + `collapse_degenerate_intersections` | osm2streets | ~200 | Phase 1 |
| 4-case `intersection_polygon` | osm2streets | ~500 | Phase 3 |
| `update_geometry` (idempotent recompute) | osm2streets | ~80 | Phase 3 |
| Cross-section width normalizer (per-interaction resolutions) | Streetmix | ~30 | Phase 2 |
| `insertSeparatorSegments` | 3DStreet | ~30 | Phase 2 |
| Cumulative offset polyline rendering | 3DStreet (concept) | ~60 | Phase 2 |
| `classifyTurn` | LaneMaker | ~15 | Phase 2.5 |
| `fitCubicBezier` for ray connections | LaneMaker | ~40 | Phase 3 |
| Probe-based junction boundary (for complex junctions) | LaneMaker | ~200 | Phase 3 |
| Conflict graph + signal phase generator | LaneMaker | ~100 | Phase 4 |
| GeoJSON + MapLibre match-expression rendering | osm2streets | ~100 | Phase 2 |
| Transform pipeline + debug snapshots | osm2streets | ~80 | cross-cutting |
| Citable-rule data schema | Streetmix (concept) | ~20 (schema) | Phase 4 |

**Total: ~2,300 LOC of ported / adapted logic across the five MVP phases.** Everything else is app-level code (React components, Zustand slices, MapLibre setup) that's standard.

---

## 6. Revised plan deltas

Three concrete changes to the original plan based on what I actually found in the code.

### 6.1 Phase 1 no longer needs a naive fallback + escalation

The original plan said: "start with a naive network builder; escalate to osm2streets WASM if it breaks." Having read the code: the osm2streets logic is ~900 LOC of TypeScript equivalent total (network construction + two collapse transforms + the 4-case polygon algorithm). We port it directly. No WASM dependency, no fallback path, no decision point.

**Phase 1 estimate moves from "1–2 weeks" to "2 weeks" (flat)** with the port included.

### 6.2 Phase 3 gets a two-backend junction geometry system

Simple junctions use the osm2streets approach (corner fillet from edge collisions). Complex junctions use the LaneMaker approach (probe-based boundary from connecting road edges). The switch is automatic based on a heuristic, with a user override:

- Use osm2streets if: ≤4 approaches AND all adjacent heading deltas ≥ 45° AND width ratio max/min ≤ 2.
- Else use LaneMaker probe method.

This is what makes the "Indian junction" case work. The CMS-Adyar-style junction in your reference image has 6 approaches at varying widths and an island — osm2streets alone produces a bad polygon for it.

### 6.3 Add Phase 2.5 — movement graph

After cross-sections are assigned, walk every (incoming, outgoing) pair at every junction, classify the turn with `classifyTurn`, and build the movement graph. ~3 days.

This unlocks: turn arrows in rendering, validation of OSM `turn:lanes=*` tags, input for the Phase 4 signal generator, input for crossing placement (pedestrians cross where vehicles turn).

---

## 7. The invariants that must not drift

Three invariants across all the borrowed logic. If any of these drift, things break silently.

1. **`Intersection.roads` is always sorted clockwise.** Every geometry algorithm assumes this. Centralize sort logic in `sortRoadsAt(intersectionId)`; call after every road insertion/removal.

2. **Center line = reference line trimmed by `trimStart`/`trimEnd`.** Never store a pre-trimmed polyline. Always recompute from reference + trims. `update_geometry()` sets trims; the getter computes the line.

3. **Widths are in metres. Coordinates are in a local projected CRS (metres).** Lat/lon only exists at import and export boundaries. Never mix units. `Distance` as a branded type if TypeScript lets us.

---

## 8. What I'd do first, in order

1. **Port `PolyLine` + `geom` primitives from osm2streets.** Everything builds on this. Write tests against known inputs before moving on — this library needs to be correct or nothing downstream works.
2. **Port the 4-case `intersection_polygon`.** Validate against fixtures from `osm2streets/tests/`. Indian test cases come next.
3. **Build Phase 1 end-to-end** — Overpass → network → rendered in MapLibre. Test on one real Indian bbox.
4. **Spike Phase 3 junction editing on one real junction.** Pick a specific Pune or Bangalore junction; get it from OSM "before" to Kumar-Park-style "after" in schematic form. Whatever breaks here reveals what's missing.

Don't build Phase 2 (cross-section editing) before the spike. The junction editor is where this product lives or dies; every other feature is plumbing for it.
