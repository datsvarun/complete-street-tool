# CST — Interchange Export Design (GeoJSON ✅ / DXF planned)

## 1. GeoJSON (shipped)

`app/src/export/geojson.ts` — one `FeatureCollection` in WGS84 (EPSG:4326),
button in the Export panel. Reuses the exact canvas derivations (bands,
junctions with CAD vertex overrides applied, transitions, elements as points,
patches, traced boundaries). Every feature carries a `layer` property
(`centerline | band | junction | junction-band | transition | element |
patch | boundary`) plus its identifying attributes, so QGIS/Kepler styling
and filtering "just work". Coordinates go through `toLatLon(origin, …)` —
lat/lon exists only at this boundary, per the CLAUDE.md rule.

**Not yet included:** derived markings (dividers/decals — they're pure
graphics; add as `MultiLineString layer:"marking"` if a consumer needs them)
and the roundabout preview circles.

## 2. DXF (designed, not yet built)

A CAD deliverable wants **local metres**, not lat/lon — surveyors set up on a
station, not a graticule. Plan:

- **Format:** ASCII DXF R12 (AC1009). Oldest, most universally read dialect;
  needs only `HEADER` (`$INSUNITS` 6 = metres), `TABLES` (layer table),
  `ENTITIES`. No blocks/objects sections required. A hand-rolled writer is
  ~120 lines — no dependency needed.
- **CRS:** the local tangent plane as-is (x east, **y flipped to north-up**:
  DXF is y-up, our world is y-down → emit `-y`). Put the WGS84 origin in a
  comment (`999`) header line and as a `TEXT` entity near (0,0) so the
  drawing can be georeferenced later.
- **Layer mapping** (mirrors the GeoJSON `layer` property):
  | DXF layer | entity | source |
  |---|---|---|
  | `CST-CENTERLINE` | `POLYLINE`/`LWPOLYLINE` open | edge points |
  | `CST-BAND-<KIND>` | closed `POLYLINE` | ribbon bands (overrides applied) |
  | `CST-JUNCTION` | closed `POLYLINE` | junction rings + cover bands |
  | `CST-JUNCTION-BAND` | closed `POLYLINE` | wedges/noses |
  | `CST-MARKING` | open `POLYLINE` | dividers, separator markings, decals |
  | `CST-ELEMENT` | `CIRCLE` + `TEXT` label | element frames |
  | `CST-BOUNDARY` | open `POLYLINE` | traced plot lines |
  | `CST-PATCH-<KIND>` | closed `POLYLINE` | edit patches |
  Colors: nearest ACI color per `KIND_COLORS`.
- **API:** `export/dxf.ts: buildDxf(g, designs, elements, patches, boundaries,
  vertexOverrides, blend): string` — same signature family as `buildGeoJson`,
  same derivation reuse. Export panel gets a third download button.
- **Effort estimate:** one focused session including a vitest that parses the
  output back (group-code pairs) and a round-trip open in LibreCAD/ODA to
  sanity-check. R12 quirks to watch: `LWPOLYLINE` is R13+ — R12 uses
  `POLYLINE`+`VERTEX`+`SEQEND`; keep coordinates ≤ 6 decimals.

## 3. Later
- glTF from the 3D `SceneSpec` (near-free — spec is renderer-agnostic).
- IFC alignment (`IfcRoad`, IFC 4.3) if BIM interop is ever needed — large;
  only on real demand.
