# CST — Junction Generation & Editing Tool Design

**Status:** Design document for Stage 2A proper (Plan v2 §4 expanded). Governs the junction work slices. The current implementation (plain clustered polygons, cosmetic fillets, per-end trims) is the substrate this builds on.

**The one-sentence architecture:** a junction is a *derived, parametric artifact* — a pipeline from (graph + sections + movements + type + user parameter overrides) to component-level geometry — where the user edits **parameters with stable keys**, never polygon points, so everything regenerates safely when the network changes (Plan v2 §1.2).

---

## 1. What "smart initial design" must produce

Today's output is one grey polygon. A credible urban-design junction is **component-level** geometry:

1. **Carriageway surface** — bounded by curb lines that sweep around each corner as *fillet arcs* with a real turning radius.
2. **Corner wedges** — the raised area at each corner where the footpath/cycle-track/buffer stacks of two adjacent streets **bridge into each other seamlessly** (a 2.5 m footpath meeting a 3.0 m footpath wraps the corner, interpolating width).
3. **Median noses** — divided approaches' medians end with a set-back rounded nose, not a butt cut.
4. **Elements** — crossings, stop lines, refuges, islands, signal markers — seeded by the junction *type template*, individually editable afterward.

### The key reuse: corners are transitions on an arc

The transition engine already solves "match two component stacks and blend smoothly" (LCS matching + smoothstep sampling along a path). A corner is the same problem with a different path and direction:

- **Transition:** match sections left↔right, blend along the centerline.
- **Corner:** match the two adjacent approaches' *curb-side stacks* **outside-in** (footpath↔footpath, cycle↔cycle; unmatched taper to zero), blend along the **fillet arc**, offsetting *outward* from the curb.

`sampleTransitionBands(path, matched, …)` takes the arc as its path. One new matcher (outside-in instead of left-right), one sign flip. This is what makes "bridge different street types seamlessly" cheap instead of a rewrite.

---

## 2. The corner solver (fillets with real turning radii)

### 2.1 Geometry

Per adjacent approach pair (A right side, B left side), both away-oriented from the junction:

1. **Curb lines**: for each side, curb offset = Σ(raised components outboard of the drivable surface). Drivable/flush = carriageway, mixed, service, BRT, **parking** (flush in Indian practice); raised = footpath, cycle track, MUZ/MFZ, buffer, tree line, bus stop. No section → fallback half-width, empty raised stack.
2. **Tangent-arc construction**: offset A's curb polyline inward by R and B's curb inward by R; their intersection is the arc **center**; perpendicular feet on each curb are the **tangent points**; the fillet is the arc between them. (Polyline-aware: walk segments; if the tangent point falls beyond a segment, continue along the polyline.)
3. **Trims fall out for free**: the tangent-point *station* on each approach is that corner's natural trim — replacing today's projected-corner trims. Approach trim = max over its two corners (+ crossing setback later).
4. The current side-collision corner + clamp stays as **fallback** when tangent construction fails (§4 cases).

### 2.2 Radius selection ("smart" defaults)

R is data, not code — a citable table (like §3.1 priorities), keyed by the *turning movement the corner serves*. India drives on the left, so **corners serve left turns**; that movement's street classes pick the radius:

| corner between | default R | source (verify) |
|---|---|---|
| local ↔ local | 4.5 m | IRC:103 kerb radii |
| local ↔ collector/arterial | 6 m | IRC:103 |
| arterial ↔ arterial | 9 m | IRC:103 |
| bus route on either leg | 12 m | IRC:103 / code for buses |
| channelized free-left | 12–15 m + island | IRC:103 |

Two constraints check the chosen R (warnings, not blockers — Case_Study §2.3):
- **Design-vehicle minimum** (car ≈ 6 m, LCV ≈ 9 m, bus ≈ 12 m *effective* radius). Effective radius may exceed curb radius when parking/cycle lanes exist — compute effective R = curb R + flush outboard widths, so tight urban curbs pass when a parking lane provides the sweep. This is the NACTO/GDCI argument and it's what lets us keep pedestrian-friendly tight corners.
- **Urban maximum** (big radii = fast turns + long crossings): warn above ~15 m unless channelized.

### 2.3 Corner keys (stability under regeneration)

A corner is identified by its two approach edge-*ends* (`e12:end + e15:start`), not by index. User overrides (`radiusM`, `chamfer`) live under that key and survive any regeneration; if an approach vanishes, the override is silently dropped (or listed as stale). Same convention for per-approach overrides (`trimM`, crossing on/off, stop-line offset).

---

## 3. Data model & pipeline

```ts
// Stored ONLY when the user touches something; otherwise the junction is 100% derived.
interface JunctionDesign {
  key: string;                       // stable cluster signature (sorted node ids at creation)
  type: 'priority' | 'signalized' | 'roundabout' | 'grade-separated';
  cornerOverrides: Record<CornerKey, { radiusM?: number; chamfer?: boolean }>;
  approachOverrides: Record<EdgeEndKey, { trimM?: number; crossing?: CrossingParams | null; stopLineOffsetM?: number }>;
  elements: JunctionElement[];       // template-seeded, individually editable; placedBy: 'template' | 'user'
  touched: boolean;                  // drives STALE-vs-silent-regenerate (Plan v2 §1.2)
}
```

**Pipeline per cluster** (pure function, memoized):
```
approaches (away-oriented, curb offsets, raised stacks, refM-aware)
  → movements (Phase 2.5: classifyTurn per in/out pair)
  → type (stored ?? OSM tags: traffic_signals → signalized, junction=roundabout ?? 'priority')
  → corner solver per adjacent pair (R = override ?? table; tangent arcs; trims)
  → surface assembly: curb ring (caps + arcs) = carriageway surface polygon
  → corner wedges: outside-in matched stacks sampled along each arc
  → median noses: trim median band, semicircular cap, refuge if crossing present
  → template elements (crossings, stop lines, islands, markers) as parametric anchors
  → validation (radius vs vehicle, crossing length > 12 m → refuge, roundabout deflection)
```
Rendering: surface under ribbons, wedges beside ribbons, elements/markings on top. Editing handles are a view over the same parameters.

---

## 4. Case & edge-case matrix

| case | handling |
|---|---|
| T (3-way, ~90°) | 2 real corners + 1 through-side: the through curb runs straight (or gentle arc) — no fillet on the flat side |
| Y / skewed 3-way | acute corner: tangent points slide far up the legs — cap tangent station at 0.45·edge length, reduce R to fit |
| 4-way skewed | corners get different R per angle; obtuse corners (>150°) degrade to a small chamfer (fillet degenerates) |
| 5+ ways / shallow adjacent pair (< 30°) | LaneMaker **probe method** for the boundary (Case_Study §4.2); corners between shallow pairs become probe-sampled curves, not arcs |
| complex clusters (merged) | corner pairs are adjacent approaches around the cluster hull — same solver; internal edges stay junction surface |
| divided approach (median) | median nose set back ~ crossing width + 1 m; crossing splits with a refuge in the median (template) |
| approach without a section | fallback width, empty raised stack → corner has an arc but no wedge; listed in the review queue |
| mismatched stacks (footpath+cycle meets footpath-only) | outside-in match: footpath bridges, cycle tapers out around the arc (exactly like a dropped component in a transition) |
| R doesn't fit (short frontage / both corners of a narrow approach collide) | solve R_max per corner from available tangent stations; shrink proportionally; warn |
| two edges between the same node pair (loop) | near-parallel pair → probe/clamp path; never tangent arcs |
| terminus stub inside a cluster | treat as zero-width approach: no corner, cap only |
| one-way street | geometry identical; movements differ (feeds signals/arrows, not shape) |

---

## 5. Junction types = templates (parametric seeders)

A template is `(junction, movements) → JunctionElement[]` — it seeds, everything stays editable, re-applying regenerates with keep/STALE protection for user-touched elements.

- **Priority (default):** corner fillets + zebra crossings on approaches with footpaths (setback ~2–3 m from curb arc) + curb ramps at crossing ends + refuges where crossing length > 12 m (IRC:103, verify).
- **Signalized:** priority + stop lines at `crossing setback + 1 m`, signal-head markers per approach, optional right-turn pockets — generated as **sectionOverrides on the approach edges**, reusing the Stage 2 machinery wholesale (Plan v2 §4.2's explicit trick). Default phase plan from LaneMaker's greedy conflict-graph coloring (Case_Study §4.3) — publishable as "Phase 1: N–S through…" in export.
- **Roundabout:** central island (R seeded from inscribed circle of the boundary), circulatory carriageway width from the largest approach, splitter islands (teardrop between entry/exit curb arcs), **deflection check** (no straight path faster than ~100 m radius — warning). Entries/exits use the same tangent-arc solver against the circulatory circle instead of the opposite curb.
- **Grade-separated:** at-grade elements only outside the flyover span; piers as furniture markers (flyovers stay attributes per Plan v2 §0.4).

LHT note: all templates assume left-hand traffic (left turns hug corners, right turns cross and get pockets/phases). Keep a single `DRIVE_SIDE` constant so the logic is honest about it.

---

## 6. Editing UX (customizable on each edge)

Selecting a junction in Stage 2A enters the **focused junction view** (Plan v2 §4.3 — camera + dimming, not a separate document):

- **Corner handles:** a dot on each fillet arc's midpoint; drag along the corner bisector → live R (snap 0.5 m, readout, red when violating the vehicle minimum). Right-click → chamfer/reset.
- **Approach handles:** square at each junction mouth; drag along the centerline → trim override. Per-approach quick toggles: crossing on/off, refuge, stop line.
- **Type dropdown + "re-apply template"** (with keep/regenerate prompt when touched).
- **Movement arrows** (Phase 2.5) rendered in focus mode — they explain *why* the template put a pocket or phase where it did.
- Everything the user touches sets `touched`/`placedBy: 'user'` → upstream edits mark STALE instead of silently regenerating (badge + one batched prompt per gesture, Plan v2 §9.1).

---

## 7. Implementation slices (each independently shippable)

| # | slice | contents | reuses |
|---|---|---|---|
| J1 | **Corner solver** | tangent-arc fillets on curb lines, R table, trims from tangent stations, R-fit solving, fallback to probe/clamp | current cluster machinery |
| J2 | **Corner wedges + noses** | outside-in stack matching, arc-path sampling, median noses | `matchComponents`, `sampleTransitionBands` |
| J3 | **JunctionDesign store + handles** | stable keys, corner/trim handles, focused view, STALE plumbing | zundo, focusNode |
| J4 | **Movement graph** (Phase 2.5) | `classifyTurn` per in/out pair, arrows in focus view | Case_Study §4.1 (~15 LOC core) |
| J5 | **Priority + signalized templates** | crossings, ramps, refuges, stop lines, signal markers, turn pockets via sectionOverrides, conflict-graph phases | Stage 2 overrides, J4 |
| J6 | **Roundabout template** | island, circulatory, splitters, deflection warning | J1 solver vs circle |
| J7 | **Probe-method integration + validation pass** | 5+/shallow boundary quality, radius/crossing/deflection warnings surfaced like the review list | LaneMaker port |

J1+J2 transform the visual quality (real curbs, seamless wraps) and are pure geometry on today's derived path — no store changes, lowest risk, highest visible payoff. J3 is where "customizable on each edge" lands. J4 is half a week and unblocks everything template-shaped.

## 8. Risks

1. **Tangent construction on curved/short curbs** — most brittle math; fixture-test it first (osm2streets test-fixture habit), fall back to probe aggressively.
2. **Radius data credibility** — R table numbers ship flagged `(verify)` until checked against IRC:103/SP:118; the validator says "verify" too (Plan v2 §9.3).
3. **Handle/regeneration interaction** — pause history during drags (established pattern), stable keys everywhere, or editing will feel haunted.
4. **Scope discipline** — J5–J6 are where infinite polish lives; the done-when is Plan v2 §8 Phase 3's: one real 5-way junction, template + manual tweaks, legible.
