// The contents of each ribbon tab. Each tab is a row of RGroups; anything
// list-shaped (streets, junctions, the section catalogue, validation) opens
// as a flyout so the band stays one row high.
import { useMemo, useRef, useState } from 'react';
import { LAYER_LABELS, useCst } from '../store';
import type { Basemap, LayerKey } from '../store';
import { CATALOG_BY_ROW, getSection, KIND_COLORS, KIND_LABELS } from '../catalog';
import { polylineLength } from '../geometry/polyline';
import { validateGraph } from '../graph/validate';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import { ELEMENT_LABELS } from '../detailing/elements';
import { HATCH_LABELS, STYLE_PRESETS } from '../style/kindStyles';
import type { HatchStyle, StylePreset } from '../style/kindStyles';
import { esc, framePlanSvg, planContent } from '../export/plan';
import { buildGeoJson } from '../export/geojson';
import { geoJsonToLines, readGeoJsonLines } from '../import/geojson';
import { centerLines, parseDxf } from '../import/dxf';
import type { MeshFn } from '../mesh/engine';
import type { ComponentKind, ElementKind, JunctionType, PatchKind, Stage, Tool } from '../types';
import { RBtn, RFlyout, RGroup, RStack } from './RibbonParts';

// ── Shared tool groups ───────────────────────────────────────────────────

type ToolDef = { id: Tool; icon: string; label: string; hint: string; stages?: Stage[] };

const SELECT_TOOLS: ToolDef[] = [
  { id: 'select', icon: '➤', label: 'Select', hint: 'Selection — click streets, Shift adds, Ctrl toggles (V)' },
  { id: 'direct', icon: '▷', label: 'Direct', hint: 'Direct selection — move nodes and vertices (A)', stages: ['network'] },
  { id: 'marquee', icon: '▭', label: 'Rect', hint: 'Rectangle select — drag a box (M)' },
  { id: 'lasso', icon: '◌', label: 'Lasso', hint: 'Lasso select — draw around streets (L)' },
];

const MODIFY_TOOLS: ToolDef[] = [
  { id: 'split', icon: '✂', label: 'Split', hint: 'Split a street at a point (X)', stages: ['network', 'sections'] },
  { id: 'erase', icon: '⌫', label: 'Delete', hint: 'Delete — click a street or node to remove it (E)', stages: ['network', 'sections'] },
];

function ToolButtons({ tools }: { tools: ToolDef[] }) {
  const stage = useCst((s) => s.stage);
  const tool = useCst((s) => s.tool);
  const setTool = useCst((s) => s.setTool);
  return (
    <>
      {tools.map((t) => {
        const enabled = !t.stages || t.stages.includes(stage);
        return (
          <RBtn
            key={t.id}
            icon={t.icon}
            label={t.label}
            title={t.hint + (enabled ? '' : ' — not available in this tab')}
            active={tool === t.id}
            disabled={!enabled}
            onClick={() => setTool(tool === t.id ? 'select' : t.id)}
          />
        );
      })}
    </>
  );
}

function SelectGroup() {
  return (
    <RGroup title="Select">
      <ToolButtons tools={SELECT_TOOLS} />
    </RGroup>
  );
}

function BoundaryGroup() {
  const boundaryDraw = useCst((s) => s.boundaryDraw);
  const setBoundaryDraw = useCst((s) => s.setBoundaryDraw);
  const boundaryCount = useCst((s) => Object.keys(s.boundaries).length);
  return (
    <RGroup title="Plot / ROW boundary">
      <RBtn
        icon="⌐"
        label={boundaryDraw ? 'Click on canvas…' : 'Trace'}
        title="Trace compound walls and plot lines first — the land you actually have — then design the street inside them. Enter or double-click finishes."
        active={boundaryDraw}
        onClick={() => setBoundaryDraw(!boundaryDraw)}
      />
      {boundaryCount > 0 && <span className="rb-info">{boundaryCount} traced</span>}
    </RGroup>
  );
}

// ── Network ──────────────────────────────────────────────────────────────

const MAX_IMPORT_KM2 = 3; // keeps the Overpass query and the graph tractable

function ImportGroup() {
  const importBusy = useCst((s) => s.importBusy);
  const importOsmBbox = useCst((s) => s.importOsmBbox);
  const importFilters = useCst((s) => s.importFilters);
  const setImportFilter = useCst((s) => s.setImportFilter);
  const setBoxDraw = useCst((s) => s.setBoxDraw);
  const boxDraw = useCst((s) => s.boxDraw);
  const importBox = useCst((s) => s.importBox);
  const setBox = useCst((s) => s.setBox);
  const geoRef = useRef<HTMLInputElement>(null);
  const dxfRef = useRef<HTMLInputElement>(null);

  const km2 = importBox ? ((importBox.maxX - importBox.minX) * (importBox.maxY - importBox.minY)) / 1e6 : 0;
  const over = km2 > MAX_IMPORT_KM2;
  const sizeText = importBox
    ? `${(importBox.maxX - importBox.minX).toFixed(0)} × ${(importBox.maxY - importBox.minY).toFixed(0)} m`
    : '';

  const importFile = async (file: File, kind: 'geojson' | 'dxf') => {
    const s = useCst.getState();
    try {
      const text = await file.text();
      if (kind === 'dxf') {
        s.importLines(centerLines(parseDxf(text)), file.name);
        return;
      }
      const parsed = readGeoJsonLines(JSON.parse(text));
      if (!parsed) {
        useCst.setState({ statusMsg: `${file.name}: no LineString features in WGS84 lon/lat` });
        return;
      }
      // An empty design re-anchors on the file; otherwise the file lands on
      // the existing map anchor so it lines up with what is already drawn.
      const origin = Object.keys(s.edges).length === 0 || !s.origin ? parsed.center : s.origin;
      s.importLines(geoJsonToLines(parsed, origin), file.name, origin);
    } catch {
      useCst.setState({ statusMsg: `Import failed: ${file.name} could not be read` });
    }
  };

  const filter = (key: keyof typeof importFilters, label: string, title: string) => (
    <label className="rb-check" title={title}>
      <input type="checkbox" checked={importFilters[key]} onChange={(e) => setImportFilter(key, e.target.checked)} />
      {label}
    </label>
  );

  return (
    <RGroup title="Import">
      <RBtn
        icon="▭"
        label={boxDraw === 'import' ? 'Drag on canvas…' : importBox ? 'Redraw area' : 'OSM area'}
        title="Import from OpenStreetMap: pan/zoom (or search a place) to the area you want, drag a box, then Download. Replaces the current network."
        active={boxDraw === 'import'}
        onClick={() => setBoxDraw(boxDraw === 'import' ? null : 'import')}
      />
      <RBtn
        icon="⇩"
        label={importBusy ? 'Downloading…' : 'Download'}
        title={
          !importBox
            ? 'Draw an OSM area first'
            : over
              ? `${sizeText} is too large (max ${MAX_IMPORT_KM2} km²) — draw a smaller box`
              : `Download ${sizeText} from OpenStreetMap — replaces the current network. Data © OpenStreetMap contributors.`
        }
        disabled={!importBox || over || importBusy}
        onClick={() => importOsmBbox()}
      />
      <RStack>
        {filter('flyovers', 'flyovers', 'Keep elevated ways (bridge=*) — off imports the at-grade network only')}
        {filter('serviceRoads', 'service lanes', 'Keep service alleys and parking aisles')}
        {filter('paths', 'footpaths', 'Also import separate footway/path geometries')}
      </RStack>
      {importBox && (
        <RStack>
          <span className={over ? 'rb-info warn' : 'rb-info'}>{sizeText}</span>
          <RBtn small label="Clear area" onClick={() => setBox('import', null)} />
        </RStack>
      )}
      <RBtn
        icon="{ }"
        label="GeoJSON"
        title="Import street centerlines from a GeoJSON file (LineString / MultiLineString, WGS84). Adds to the current network."
        onClick={() => geoRef.current?.click()}
      />
      <RBtn
        icon="◫"
        label="DXF"
        title="Import street centerlines from an ASCII DXF file (LINE, LWPOLYLINE, POLYLINE, ARC). The drawing is centred on the map anchor and added to the current network."
        onClick={() => dxfRef.current?.click()}
      />
      <input
        ref={geoRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f, 'geojson');
          e.target.value = '';
        }}
      />
      <input
        ref={dxfRef}
        type="file"
        accept=".dxf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f, 'dxf');
          e.target.value = '';
        }}
      />
    </RGroup>
  );
}

function ValidationFlyout() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const mergeNodePair = useCst((s) => s.mergeNodePair);
  const focusNode = useCst((s) => s.focusNode);
  const issues = useMemo(() => validateGraph({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }), [nodes, edges]);

  // Unconnected node pairs closer than 2 m — junction geometry degenerates on
  // these later, so surface them with a one-click merge (grid-bucketed scan).
  const nearPairs = useMemo(() => {
    const TOL = 2;
    const cells = new Map<string, string[]>();
    for (const n of Object.values(nodes)) {
      const k = `${Math.floor(n.x / TOL)}:${Math.floor(n.y / TOL)}`;
      (cells.get(k) ?? cells.set(k, []).get(k)!).push(n.id);
    }
    const linked = new Set(Object.values(edges).flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]));
    const out: Array<{ a: string; b: string; d: number }> = [];
    for (const n of Object.values(nodes)) {
      const cx = Math.floor(n.x / TOL);
      const cy = Math.floor(n.y / TOL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const mid of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
            if (mid <= n.id) continue; // each pair once
            const m = nodes[mid];
            const d = Math.hypot(m.x - n.x, m.y - n.y);
            if (d < TOL && !linked.has(`${n.id}|${mid}`)) out.push({ a: n.id, b: mid, d });
          }
        }
      }
    }
    return out.sort((p, q) => p.d - q.d).slice(0, 12);
  }, [nodes, edges]);

  const count = issues.length + nearPairs.length;
  return (
    <RFlyout icon={count ? '⚠' : '✓'} label="Validation" badge={count} title="Graph checks: near-duplicate nodes, dangling references, zero-length edges">
      <h3>Validation</h3>
      {nearPairs.length > 0 && (
        <>
          <p className="small issues-inline">
            ⚠ {nearPairs.length} node pair(s) closer than 2 m — merge them to avoid junction geometry errors later.
          </p>
          <ul className="edge-list">
            {nearPairs.map((p) => (
              <li key={`${p.a}-${p.b}`} className="row-between small">
                <button onClick={() => focusNode(p.a)}>
                  {p.a} ↔ {p.b}
                  <span className="muted small"> · {p.d.toFixed(2)} m apart</span>
                </button>
                <button className="mini" onClick={() => mergeNodePair(p.a, p.b)}>
                  Merge
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {issues.length === 0 ? (
        <p className="ok small">✓ graph valid — no dangling refs, no zero-length edges</p>
      ) : (
        <ul className="issues small">
          {issues.slice(0, 8).map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
          {issues.length > 8 && <li>… {issues.length - 8} more</li>}
        </ul>
      )}
    </RFlyout>
  );
}

function StreetsFlyout() {
  const nodeCount = useCst((s) => Object.keys(s.nodes).length);
  const edges = useCst((s) => s.edges);
  const selectedEdgeIds = useCst((s) => s.selectedEdgeIds);
  const selectEdge = useCst((s) => s.selectEdge);
  const edgeList = useMemo(() => Object.values(edges), [edges]);
  return (
    <RFlyout icon="☰" label="Streets" badge={edgeList.length} title="List of every street in the network">
      <h3>
        Streets ({edgeList.length}) · nodes {nodeCount}
      </h3>
      {edgeList.length === 0 && <p className="muted">Import an area, or use the Draw tab and click on the canvas.</p>}
      <ul className="edge-list tall">
        {edgeList.map((e) => (
          <li key={e.id}>
            <button
              className={selectedEdgeIds.includes(e.id) ? 'active' : ''}
              onClick={(ev) => selectEdge(e.id, ev.shiftKey)}
            >
              <strong>{e.id}</strong> · {polylineLength(e.points).toFixed(0)} m
              <span className="muted small">
                {' '}
                {e.name ?? e.highway ?? ''}
                {e.carriagewayType === 'divided' ? ' · divided' : e.oneway ? ' · oneway' : ''}
                {e.section ? ' · sectioned' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </RFlyout>
  );
}

function DeleteSelectedBtn() {
  const selectedEdgeIds = useCst((s) => s.selectedEdgeIds);
  const removeEdges = useCst((s) => s.removeEdges);
  const n = selectedEdgeIds.length;
  return (
    <RBtn
      icon="🗑"
      label={n > 1 ? `Delete ${n}` : 'Delete'}
      title={n ? `Delete the ${n} selected street(s) (Del)` : 'Select one or more streets first'}
      danger
      disabled={n === 0}
      onClick={() => removeEdges(selectedEdgeIds)}
    />
  );
}

export function NetworkTab() {
  const selectedEdgeIds = useCst((s) => s.selectedEdgeIds);
  const mergeSelectedAsDc = useCst((s) => s.mergeSelectedAsDc);
  const dcCandidates = useCst((s) => s.dcCandidates);
  const simplifyAll = useCst((s) => s.simplifyAll);
  const cleanNetwork = useCst((s) => s.cleanNetwork);
  const scanDualCarriageways = useCst((s) => s.scanDualCarriageways);
  const applyDcMerge = useCst((s) => s.applyDcMerge);
  const setHighlight = useCst((s) => s.setHighlight);

  return (
    <>
      <ImportGroup />
      <BoundaryGroup />
      <RGroup title="Clean">
        <RBtn icon="⇥" label="Collapse" title="Collapse short and pass-through segments" onClick={() => cleanNetwork()} />
        <RBtn icon="〰" label="Simplify" title="Simplify street geometry (1 m tolerance)" onClick={() => simplifyAll(1)} />
      </RGroup>
      <RGroup title="Dual carriageways">
        <RBtn icon="⇉" label="Find" title="Scan for pairs of parallel one-way streets" onClick={() => scanDualCarriageways()} />
        <RBtn
          icon="⊞"
          label="Merge 2"
          title={
            selectedEdgeIds.length === 2
              ? 'Merge the two selected parallel streets at their midline'
              : 'Shift-click two parallel streets first'
          }
          disabled={selectedEdgeIds.length !== 2}
          onClick={() => mergeSelectedAsDc()}
        />
        {dcCandidates && (
          <RFlyout icon="≡" label="Candidates" badge={dcCandidates.length} title="Detected dual-carriageway pairs">
            <h3>Dual-carriageway candidates</h3>
            {dcCandidates.length === 0 && <p className="muted small">None detected.</p>}
            {dcCandidates.map((c) => (
              <div
                key={`${c.e1}-${c.e2}`}
                className="dc-row"
                onMouseEnter={() => setHighlight([c.e1, c.e2])}
                onMouseLeave={() => setHighlight([])}
              >
                <span>
                  {c.name ?? `${c.e1} ↔ ${c.e2}`}
                  <span className="muted small"> · sep {c.meanSepM.toFixed(1)} m</span>
                </span>
                <button onClick={() => applyDcMerge(c)}>Merge</button>
              </div>
            ))}
          </RFlyout>
        )}
      </RGroup>
      <RGroup title="Check">
        <ValidationFlyout />
        <StreetsFlyout />
        <DeleteSelectedBtn />
      </RGroup>
    </>
  );
}

// ── Draw ─────────────────────────────────────────────────────────────────

export function DrawTab() {
  const tool = useCst((s) => s.tool);
  const setTool = useCst((s) => s.setTool);
  const drawMode = useCst((s) => s.drawMode);
  const setDrawMode = useCst((s) => s.setDrawMode);
  const fitAll = useCst((s) => s.fitAll);
  const pick = (mode: 'line' | 'arc') => {
    if (tool === 'draw' && drawMode === mode) {
      setTool('select');
      return;
    }
    setDrawMode(mode);
    setTool('draw');
  };
  return (
    <>
      <SelectGroup />
      <RGroup title="Draw">
        <RBtn
          icon="╱"
          label="Line"
          title="Draw a street as straight segments — click each vertex, Enter or double-click finishes, Shift constrains to 15° (D)"
          active={tool === 'draw' && drawMode === 'line'}
          onClick={() => pick('line')}
        />
        <RBtn
          icon="◠"
          label="Arc"
          title="Draw a curved street through three clicks: start, a point on the curve, end"
          active={tool === 'draw' && drawMode === 'arc'}
          onClick={() => pick('arc')}
        />
      </RGroup>
      <RGroup title="Modify">
        <ToolButtons tools={MODIFY_TOOLS} />
        <DeleteSelectedBtn />
      </RGroup>
      <BoundaryGroup />
      <RGroup title="Navigate">
        <RBtn icon="⤢" label="Fit all" title="Fit the whole network in view (F)" onClick={fitAll} />
      </RGroup>
    </>
  );
}

// ── Street (sections) ────────────────────────────────────────────────────

export function StreetTab() {
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const reviewList = useCst((s) => s.reviewList);
  const assignSectionToSelected = useCst((s) => s.assignSectionToSelected);
  const selectEdge = useCst((s) => s.selectEdge);
  const dismissReview = useCst((s) => s.dismissReview);
  const autoAssign = useCst((s) => s.autoAssign);
  useCst((s) => s.kindStyles); // re-render when the drawing style changes
  const selected = selectedEdgeId ? (edges[selectedEdgeId] ?? null) : null;
  const currentCatalog = getSection(selected?.section?.catalogId ?? null);

  const usedKinds = new Set<ComponentKind>();
  for (const e of Object.values(edges)) {
    e.section?.components.forEach((c) => usedKinds.add(c.kind));
  }

  return (
    <>
      <SelectGroup />
      <RGroup title="Modify">
        <ToolButtons tools={MODIFY_TOOLS} />
      </RGroup>
      <RGroup title="Selected street">
        <span className="rb-info wide">
          {selected ? (
            <>
              <strong>{selected.id}</strong> · {polylineLength(selected.points).toFixed(0)} m
              {selected.name ? ` · ${selected.name}` : ''}
              <br />
              <span className="muted">
                {selected.section ? (currentCatalog ? currentCatalog.name : 'custom section') : 'no section yet'}
              </span>
            </>
          ) : (
            <span className="muted">Click a street on the canvas, or an item in the review list.</span>
          )}
        </span>
        <RBtn
          icon="✕"
          label="Remove"
          title="Remove the section from the selected street"
          danger
          disabled={!selected?.section}
          onClick={() => assignSectionToSelected(null)}
        />
      </RGroup>
      <RGroup title="Sections">
        <RFlyout
          icon="▥"
          label="Catalogue"
          wide
          title="Road sections sorted by right-of-way. “Standard” = rule of thirds (⅓ to sidewalks, 0.6 m median from 12 m up); “IRC” = SP:118-2018 configurations."
        >
          <h3>Road sections</h3>
          {!selected && <p className="muted small">Select a street first, then pick a section.</p>}
          <div className="catalog">
            {CATALOG_BY_ROW.map((group) => (
              <details key={group.rowWidthM} open>
                <summary>{group.rowWidthM} m ROW</summary>
                {group.sections.map((s) => (
                  <button
                    key={s.id}
                    className={currentCatalog?.id === s.id ? 'catalog-item active' : 'catalog-item'}
                    disabled={!selected}
                    title={selected ? s.name : 'Select a street first'}
                    onClick={() => selected && assignSectionToSelected(s.id)}
                  >
                    <span className="catalog-title">
                      {s.label}
                      <span className="muted small"> Σ {s.totalWidthM.toFixed(1)} m</span>
                    </span>
                    <span className="mini-section">
                      {s.components.map((c, i) => (
                        <span
                          key={i}
                          style={{ flexGrow: c.widthM, background: KIND_COLORS[c.kind] }}
                          title={`${c.element} ${c.widthM} m`}
                        />
                      ))}
                    </span>
                  </button>
                ))}
              </details>
            ))}
          </div>
        </RFlyout>
        <RBtn
          icon="⚙"
          label="Auto-assign"
          title="Assign a section to every unsectioned street from its highway class; doubtful ones go to the review list"
          onClick={() => autoAssign()}
        />
        <RFlyout icon="☑" label="Review" badge={reviewList.length} disabled={reviewList.length === 0} title="Streets the auto-assignment was unsure about">
          <h3>Review ({reviewList.length})</h3>
          <ul className="review-list">
            {reviewList.map((r) => (
              <li key={r.edgeId} className={r.edgeId === selectedEdgeId ? 'active' : ''}>
                <button onClick={() => selectEdge(r.edgeId)}>
                  <strong>{r.edgeId}</strong>
                  <span className="muted small"> {r.reason}</span>
                </button>
                <button className="dismiss" title="Dismiss" onClick={() => dismissReview(r.edgeId)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </RFlyout>
        <RFlyout icon="◧" label="Legend" disabled={usedKinds.size === 0} title="Colours of the components in use">
          <h3>Legend</h3>
          <ul className="legend">
            {[...usedKinds].map((k) => (
              <li key={k}>
                <span className="chip" style={{ background: KIND_COLORS[k] }} />
                {KIND_LABELS[k]}
              </li>
            ))}
          </ul>
        </RFlyout>
      </RGroup>
    </>
  );
}

// ── Junction ─────────────────────────────────────────────────────────────

const TURN_LABEL: Record<string, string> = { left: 'left', through: 'through', right: 'right', uturn: 'U-turn' };

export function JunctionTab() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const focusNode = useCst((s) => s.focusNode);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const selectedJunctionKey = useCst((s) => s.selectedJunctionKey);
  const selectJunction = useCst((s) => s.selectJunction);
  const setJunctionType = useCst((s) => s.setJunctionType);
  const setCornerRadius = useCst((s) => s.setCornerRadius);
  const setApproachTrim = useCst((s) => s.setApproachTrim);
  const removeJunctionDesign = useCst((s) => s.removeJunctionDesign);
  const junctionCorners = useCst((s) => s.settings.junctionCorners);
  const { junctions, transitions } = useMemo(
    () => deriveNodeArtifactsCached({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }, junctionDesigns, junctionCorners),
    [nodes, edges, junctionDesigns, junctionCorners],
  );
  const anySection = Object.values(edges).some((e) => e.section);
  const selected = junctions.find((j) => j.key === selectedJunctionKey) ?? null;
  const design = selected ? junctionDesigns[selected.key] : undefined;
  const staleKeys = Object.keys(junctionDesigns).filter((k) => !junctions.some((j) => j.key === k));
  const form = design?.type ?? 'priority';
  const isRegular = form === 'priority' || form === 'signalized';
  const edgeLabel = (key: string) => {
    const [edgeId] = key.split(':');
    return edges[edgeId]?.name || edgeId;
  };

  return (
    <>
      <RGroup title="Junctions">
        <RFlyout
          icon="✚"
          label="Junctions"
          badge={junctions.length}
          title="Corners, wedges and trims are derived from the graph. Drag the corner dots (radius) and mouth squares (trim) on a selected junction to override them; right-click a dot toggles chamfer, Shift+right-click resets."
        >
          <h3>Junctions ({junctions.length})</h3>
          {!anySection && (
            <p className="muted small">
              ⚠ No sections assigned yet — junction shapes use a fallback width. Assign sections in the Street tab for
              accurate geometry.
            </p>
          )}
          <ul className="edge-list tall">
            {junctions.map((j) => (
              <li key={j.key}>
                <button
                  className={j.key === selectedJunctionKey ? 'active' : ''}
                  onClick={() => {
                    selectJunction(j.key);
                    focusNode(j.nodeIds[0]);
                  }}
                >
                  <strong>{j.nodeIds.length > 1 ? `${j.nodeIds[0]}+${j.nodeIds.length - 1}` : j.nodeIds[0]}</strong> ·{' '}
                  {j.degree}-way{j.nodeIds.length > 1 ? ' complex' : ''}
                  {junctionDesigns[j.key]?.touched ? <span title="has manual overrides"> ✎</span> : null}
                  <span className="muted small"> {j.names.slice(0, 2).join(' × ') || ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </RFlyout>
        <span className="rb-info wide">
          {selected ? (
            <>
              <strong>{selected.nodeIds.join('+')}</strong> · {selected.degree}-way
              <br />
              <span className="muted">
                {(['left', 'through', 'right', 'uturn'] as const)
                  .map((t) => `${selected.movements.filter((m) => m.turn === t).length} ${TURN_LABEL[t]}`)
                  .join(' · ')}
              </span>
            </>
          ) : (
            <span className="muted">Click a junction on the canvas or pick one from the list.</span>
          )}
        </span>
      </RGroup>
      <RGroup title="Type">
        <RBtn
          icon="┼"
          label="Regular"
          title="Standard junction — fillet corners, priority or signal control"
          active={!!selected && isRegular}
          disabled={!selected}
          onClick={() => selected && setJunctionType(selected.key, 'priority')}
        />
        <RBtn
          icon="◎"
          label="Roundabout"
          title="Central island + circulatory carriageway sized from the junction. Too-small junctions show no ring — enlarge approach trims first."
          active={!!selected && form === 'roundabout'}
          disabled={!selected}
          onClick={() => selected && setJunctionType(selected.key, 'roundabout')}
        />
        <RBtn
          icon="✦"
          label="Custom"
          title="Free-form junction geometry — shape it in the Edit tab"
          active={!!selected && form === 'custom'}
          disabled={!selected}
          onClick={() => selected && setJunctionType(selected.key, 'custom')}
        />
        <RStack>
          <label className="rb-field" title="Traffic control of a regular junction">
            Control
            <select
              value={isRegular ? form : 'priority'}
              disabled={!selected || !isRegular}
              onChange={(e) => selected && setJunctionType(selected.key, e.target.value as JunctionType)}
            >
              <option value="priority">priority</option>
              <option value="signalized">signalized</option>
            </select>
          </label>
        </RStack>
      </RGroup>
      <RGroup title="Geometry">
        <RFlyout icon="◜" label="Corners" badge={selected?.corners.length} disabled={!selected} title="Corner radii of the selected junction">
          <h3>Corners</h3>
          <ul className="edge-list">
            {selected?.corners.map((c, i) => (
              <li key={c.key} className="row-between small">
                <span>
                  #{i + 1} {c.radiusM === null ? 'chamfer' : `R ${c.radiusM.toFixed(1)} m`}
                  {c.overridden ? ' ✎' : ''}
                </span>
                {c.overridden && (
                  <button className="mini" onClick={() => setCornerRadius(selected.key, c.key, null)}>
                    reset
                  </button>
                )}
              </li>
            ))}
          </ul>
        </RFlyout>
        <RFlyout icon="⇤" label="Approaches" badge={selected?.approachInfos.length} disabled={!selected} title="Trim distances of the selected junction’s approaches">
          <h3>Approaches</h3>
          <ul className="edge-list">
            {selected?.approachInfos.map((a) => (
              <li key={a.key} className="row-between small">
                <span>
                  {edgeLabel(a.key)} · trim {a.trim.toFixed(1)} m{a.overridden ? ' ✎' : ''}
                </span>
                {a.overridden && (
                  <button className="mini" onClick={() => setApproachTrim(selected.key, a.key, null)}>
                    reset
                  </button>
                )}
              </li>
            ))}
          </ul>
        </RFlyout>
        <RFlyout icon="⇄" label="Transitions" badge={transitions.length} disabled={transitions.length === 0} title="Nodes where a street changes section smoothly">
          <h3>Section transitions ({transitions.length})</h3>
          <ul className="edge-list">
            {transitions.map((t) => (
              <li key={t.nodeId}>
                <button onClick={() => focusNode(t.nodeId)}>
                  <strong>{t.nodeId}</strong>
                  <span className="muted small"> smooth section change</span>
                </button>
              </li>
            ))}
          </ul>
        </RFlyout>
        {staleKeys.length > 0 && (
          <RFlyout icon="⚠" label="Stale" badge={staleKeys.length} title="Manual overrides whose junction no longer exists">
            <h3>Stale overrides</h3>
            <p className="muted small">
              These junctions no longer exist in the network (nodes merged or deleted) but still carry manual overrides.
            </p>
            <ul className="edge-list">
              {staleKeys.map((k) => (
                <li key={k} className="row-between small">
                  <span>{k}</span>
                  <button className="mini" onClick={() => removeJunctionDesign(k)}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          </RFlyout>
        )}
      </RGroup>
    </>
  );
}

// ── Mesh ─────────────────────────────────────────────────────────────────

type MeshTool = ReturnType<typeof useCst.getState>['meshTool'];

const MESH_TOOLS: Array<{ id: MeshTool; icon: string; label: string; hint: string }> = [
  { id: 'select', icon: '➤', label: 'Select', hint: 'Click a face to select it · drag nodes to reshape (shared nodes move every abutting shape)' },
  { id: 'addnode', icon: '+', label: 'Node', hint: 'Click on any shape edge to add a node there (added to every shape sharing that edge)' },
  { id: 'split', icon: '✂', label: 'Split', hint: 'Click two nodes of one face — it splits along the chord' },
  { id: 'cut', icon: '⊟', label: 'Cut', hint: 'Click a street strip — every band splits at that station (bus bays, parking bays)' },
  { id: 'merge', icon: '⊞', label: 'Merge', hint: 'Click two abutting faces to merge them' },
  { id: 'fillet', icon: '◠', label: 'Fillet', hint: 'Click a corner node — replaced by a three-point arc in every shape using it' },
  { id: 'delete', icon: '⌫', label: 'Delete', hint: 'Click a face — absorbed into its drivable neighbour' },
];

const MESH_MATERIALS: MeshFn[] = [
  'carriageway', 'footpath', 'cycle', 'parking', 'median', 'muz', 'buffer',
  'tree', 'livability', 'busstop', 'service', 'island', 'junction',
];

const meshFnLabel = (m: MeshFn) =>
  m === 'junction' ? 'Junction surface' : m === 'island' ? 'Island / refuge' : (KIND_LABELS[m as ComponentKind] ?? m);

export function MeshTab() {
  const mesh = useCst((s) => s.mesh);
  const generateMesh = useCst((s) => s.generateMesh);
  const resetMesh = useCst((s) => s.resetMesh);
  const meshTool = useCst((s) => s.meshTool);
  const setMeshTool = useCst((s) => s.setMeshTool);
  const selectedFaceId = useCst((s) => s.selectedFaceId);
  const meshRetypeSelected = useCst((s) => s.meshRetypeSelected);
  const filletR = useCst((s) => s.filletR);
  const setFilletR = useCst((s) => s.setFilletR);
  const face = mesh?.faces.find((f) => f.id === selectedFaceId) ?? null;

  return (
    <>
      <RGroup title="Mesh">
        <RBtn
          icon="⬡"
          label={mesh ? 'Regenerate' : 'Generate'}
          title="Freeze the whole design into one shared-node mesh: every point exists once and abutting shapes share nodes, so dragging one reshapes both. Changing streets or sections resets the mesh."
          onClick={() => {
            if (!mesh || mesh.editLog.length === 0 || window.confirm(`Regenerate and discard ${mesh.editLog.length} manual edit(s)?`)) {
              generateMesh();
            }
          }}
        />
        <RBtn icon="✕" label="Discard" title="Discard the mesh and its manual edits" danger disabled={!mesh} onClick={() => resetMesh()} />
        <span className="rb-info">
          {mesh ? (
            <>
              {Object.keys(mesh.nodes).length} nodes
              <br />
              {mesh.faces.length} faces
              <br />
              {mesh.editLog.length} edit(s)
            </>
          ) : (
            <span className="muted">no mesh yet</span>
          )}
        </span>
      </RGroup>
      <RGroup title="Mesh tools">
        {MESH_TOOLS.map((t) => (
          <RBtn
            key={t.id}
            icon={t.icon}
            label={t.label}
            title={t.hint}
            active={meshTool === t.id}
            disabled={!mesh}
            onClick={() => setMeshTool(t.id)}
          />
        ))}
      </RGroup>
      <RGroup title="Properties">
        <RStack>
          <label className="rb-field" title="Fillet radius (m)">
            Fillet R
            <input
              type="number"
              step={0.5}
              min={0.5}
              max={20}
              value={filletR}
              disabled={!mesh}
              onChange={(e) => setFilletR(parseFloat(e.target.value) || 3)}
            />
          </label>
          <label className="rb-field" title={face ? 'Change the selected shape’s material' : 'Select a shape to set its material'}>
            Material
            <select disabled={!face} value={face?.fn ?? ''} onChange={(e) => meshRetypeSelected(e.target.value as MeshFn)}>
              {!face && <option value="">—</option>}
              {MESH_MATERIALS.map((m) => (
                <option key={m} value={m}>
                  {meshFnLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </RStack>
      </RGroup>
    </>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────

const PRESET_LABELS: Record<StylePreset, string> = { pastel: 'Pastel + hatches', classic: 'Classic flat' };

/** Drawing style: a colour and a hatch for every component kind. */
function StyleGroup() {
  const kindStyles = useCst((s) => s.kindStyles);
  const setKindStyle = useCst((s) => s.setKindStyle);
  const setStylePreset = useCst((s) => s.setStylePreset);
  const kinds = Object.keys(kindStyles) as ComponentKind[];
  const shared = (k: ComponentKind) => kinds.some((o) => o !== k && KIND_LABELS[o] === KIND_LABELS[k]);
  return (
    <RGroup title="Style">
      <RFlyout
        icon="🎨"
        label="Colours"
        wide
        title="Colour scheme and hatch for every street element — applies to the canvas, the SVG/PDF plan and the 3D view (3D shows colours only)"
      >
        <h3>Drawing style</h3>
        <div className="tool-row">
          {(Object.keys(STYLE_PRESETS) as StylePreset[]).map((p) => (
            <button key={p} title="Replace every colour and hatch with this preset" onClick={() => setStylePreset(p)}>
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>
        <p className="muted small">Pick a preset, then tune any element. Your style is remembered in this browser.</p>
        <div className="style-grid">
          {kinds.map((k) => (
            <div key={k} className="style-row">
              <input
                type="color"
                value={kindStyles[k].color}
                title={`${KIND_LABELS[k]} colour`}
                onChange={(e) => setKindStyle(k, { color: e.target.value })}
              />
              <span>
                {KIND_LABELS[k]}
                {shared(k) && <span className="muted small"> ({k})</span>}
              </span>
              <input
                type="color"
                value={kindStyles[k].ink}
                disabled={kindStyles[k].hatch === 'none'}
                title={`${KIND_LABELS[k]} hatch line colour`}
                onChange={(e) => setKindStyle(k, { ink: e.target.value })}
              />
              <select
                value={kindStyles[k].hatch}
                title={`${KIND_LABELS[k]} hatch`}
                onChange={(e) => setKindStyle(k, { hatch: e.target.value as HatchStyle })}
              >
                {(Object.keys(HATCH_LABELS) as HatchStyle[]).map((h) => (
                  <option key={h} value={h}>
                    {HATCH_LABELS[h]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </RFlyout>
    </RGroup>
  );
}

type PaletteItem = { kind: ElementKind; variant?: string; label?: string };

const DETAIL_GROUPS: Array<{ title: string; items: PaletteItem[] }> = [
  {
    title: 'Furniture & plantation',
    items: [{ kind: 'tree' }, { kind: 'streetlight' }, { kind: 'dustbin' }, { kind: 'bench' }, { kind: 'bollard' }, { kind: 'busstop' }],
  },
  {
    title: 'Carriageway markings',
    items: [
      { kind: 'turnarrow', variant: 'through', label: 'Arrow ↑' },
      { kind: 'turnarrow', variant: 'left', label: 'Arrow ↰' },
      { kind: 'turnarrow', variant: 'right', label: 'Arrow ↱' },
    ],
  },
  {
    title: 'Crossings & entrances',
    items: [{ kind: 'zebra' }, { kind: 'raisedcrossing' }, { kind: 'driveway' }],
  },
];

const SUGGESTABLE: ElementKind[] = ['tree', 'streetlight', 'dustbin', 'zebra', 'busstop', 'turnarrow'];

export function DetailTab() {
  const placeKind = useCst((s) => s.placeKind);
  const placeVariant = useCst((s) => s.placeVariant);
  const setPlaceKind = useCst((s) => s.setPlaceKind);
  const suggest = useCst((s) => s.suggest);
  const suggestLanes = useCst((s) => s.suggestLanes);
  const clearSuggestions = useCst((s) => s.clearSuggestions);
  const elements = useCst((s) => s.elements);
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const selectEdge = useCst((s) => s.selectEdge);
  const setEdgeLanes = useCst((s) => s.setEdgeLanes);
  const [spacingText, setSpacingText] = useState('');

  const anySection = Object.values(edges).some((e) => e.section);
  const counts = useMemo(() => {
    const c: Partial<Record<ElementKind, number>> = {};
    for (const el of Object.values(elements)) c[el.kind] = (c[el.kind] ?? 0) + 1;
    return c;
  }, [elements]);
  const suggestedCount = Object.values(elements).filter((e) => e.placedBy === 'suggest').length;
  const selectedEdge = selectedEdgeId ? edges[selectedEdgeId] : null;
  const active = (kind: ElementKind, variant?: string) =>
    placeKind === kind && (placeVariant ?? undefined) === (variant ?? undefined);

  return (
    <>
      <SelectGroup />
      {DETAIL_GROUPS.map((g) => (
        <RGroup key={g.title} title={g.title}>
          <div className="rb-grid">
            {g.items.map((it) => (
              <RBtn
                key={`${it.kind}-${it.variant ?? ''}`}
                small
                label={
                  <>
                    {it.label ?? ELEMENT_LABELS[it.kind]}
                    {counts[it.kind] ? <span className="muted"> {counts[it.kind]}</span> : null}
                  </>
                }
                title={
                  anySection
                    ? 'Pick, then click a street. Objects ride the road alignment and stay inside their band — drag to move, right-click to remove.'
                    : 'Assign sections in the Street tab first — elements anchor to components'
                }
                active={active(it.kind, it.variant)}
                onClick={() => (active(it.kind, it.variant) ? setPlaceKind(null) : setPlaceKind(it.kind, it.variant ?? null))}
              />
            ))}
          </div>
        </RGroup>
      ))}
      <RGroup title="Auto-suggest">
        <RFlyout
          icon="✧"
          label="Suggest"
          badge={suggestedCount}
          title="Place evenly spaced objects automatically"
        >
          <h3>Auto-suggest</h3>
          <p className="muted small">
            Crossings go at junction approaches; bus stops come from the OSM download; turn arrows follow lane discipline
            (handedness in Settings); lane lines derive from carriageway width.
          </p>
          <label className="prop-row small">
            <span>c/c spacing (m)</span>
            <input
              type="number"
              placeholder="default"
              min={1}
              value={spacingText}
              onChange={(e) => setSpacingText(e.target.value)}
              title="Centre-to-centre distance for tree/light/bin suggestions — blank uses each type's default"
            />
          </label>
          <div className="palette">
            {SUGGESTABLE.map((k) => (
              <button key={k} className="chip" onClick={() => suggest(k, parseFloat(spacingText) || undefined)}>
                + {ELEMENT_LABELS[k]}s
              </button>
            ))}
            <button className="chip" onClick={() => suggestLanes()}>
              + Lane markings
            </button>
          </div>
          {suggestedCount > 0 && (
            <button className="mini" onClick={clearSuggestions}>
              Clear {suggestedCount} suggestion(s)
            </button>
          )}
        </RFlyout>
      </RGroup>
      <RGroup title="Lane markings">
        <RStack>
          <label className="rb-field" title="Lanes per carriageway of the selected street (dashed lane lines)">
            Lanes
            <select
              disabled={!selectedEdge}
              value={selectedEdge?.lanes ?? 0}
              onChange={(e) => selectedEdgeId && setEdgeLanes(selectedEdgeId, parseInt(e.target.value, 10))}
            >
              <option value={0}>auto / none</option>
              {[2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="rb-info">{selectedEdge ? selectedEdge.name || selectedEdgeId : 'click a street'}</span>
        </RStack>
        <RFlyout icon="☰" label="Streets" title="Sectioned streets and their lane counts">
          <h3>Sectioned streets</h3>
          <ul className="edge-list tall">
            {Object.values(edges)
              .filter((e) => e.section)
              .map((e) => (
                <li key={e.id}>
                  <button className={e.id === selectedEdgeId ? 'active' : ''} onClick={() => selectEdge(e.id)}>
                    <strong>{e.id}</strong>
                    <span className="muted small">
                      {' '}
                      {e.name || ''}
                      {e.lanes ? ` · ${e.lanes} lanes` : ''}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </RFlyout>
      </RGroup>
      <StyleGroup />
    </>
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────

// The materials a patch can be painted in, plus 'cut' (erase to ground) —
// the escape hatch for compound walls and geometry the pipeline can't express.
const PATCH_KINDS: PatchKind[] = ['footpath', 'carriageway', 'cycle', 'buffer', 'median', 'muz', 'livability', 'parking', 'cut'];

export function EditTab() {
  const patches = useCst((s) => s.patches);
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const selectedShapeKey = useCst((s) => s.selectedShapeKey);
  const selectShape = useCst((s) => s.selectShape);
  const clearShapeOverrides = useCst((s) => s.clearShapeOverrides);
  const meshEdit = useCst((s) => s.meshEdit);
  const setMeshEdit = useCst((s) => s.setMeshEdit);
  const patchKind = useCst((s) => s.patchKind);
  const setPatchKind = useCst((s) => s.setPatchKind);
  const patchDraft = useCst((s) => s.patchDraft);
  const selectedPatchId = useCst((s) => s.selectedPatchId);
  const selectPatch = useCst((s) => s.selectPatch);
  const removePatch = useCst((s) => s.removePatch);
  useCst((s) => s.kindStyles); // re-render when the drawing style changes
  const focusPatch = (pts: number[]) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    useCst.setState({ pendingFit: { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 } });
  };
  const list = Object.values(patches);
  const editedCount = Object.keys(vertexOverrides).length;

  return (
    <>
      <SelectGroup />
      <RGroup title="Node editing">
        <RStack>
          <label
            className="rb-check"
            title="Click any generated surface to outline it, then drag its nodes. On: shared (green) nodes move every abutting shape, so shapes never tear apart. Off: a drag moves only the selected shape's vertex. Right-click a node resets it."
          >
            <input type="checkbox" checked={meshEdit} onChange={(e) => setMeshEdit(e.target.checked)} />
            Welded nodes
          </label>
          {selectedShapeKey && (
            <span className="rb-info">
              {selectedShapeKey}{' '}
              <button className="mini" onClick={() => selectShape(null)}>
                done
              </button>
            </span>
          )}
        </RStack>
        <RFlyout icon="✎" label="Edited" badge={editedCount} disabled={editedCount === 0} title="Shapes with hand-moved nodes">
          <h3>Edited shapes ({editedCount})</h3>
          <ul className="edge-list">
            {Object.entries(vertexOverrides).map(([key, ov]) => (
              <li key={key} className="row-between small">
                <button className={key === selectedShapeKey ? 'active' : ''} onClick={() => selectShape(key)}>
                  {key} · {Object.keys(ov).length} node(s)
                </button>
                <button className="mini" title="reset to generated geometry" onClick={() => clearShapeOverrides(key)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </RFlyout>
      </RGroup>
      <RGroup title="Draw patch">
        <div className="rb-grid">
          {PATCH_KINDS.map((k) => (
            <RBtn
              key={k}
              small
              label={
                k === 'cut' ? (
                  '✂ Cut'
                ) : (
                  <>
                    <span className="chip-swatch" style={{ background: KIND_COLORS[k as ComponentKind] }} />
                    {KIND_LABELS[k as ComponentKind] ?? k}
                  </>
                )
              }
              title="Pick a material, click vertices on the canvas, Enter or double-click closes. Cut erases geometry. Drag vertices to refine; right-click removes."
              active={patchKind === k}
              onClick={() => setPatchKind(patchKind === k ? null : k)}
            />
          ))}
        </div>
        {patchDraft.length > 0 && <span className="rb-info">{patchDraft.length / 2} vertices</span>}
      </RGroup>
      <RGroup title="Patches">
        <RFlyout icon="▱" label="Patches" badge={list.length} title="Free-form patches and cuts">
          <h3>Patches ({list.length})</h3>
          {list.length === 0 && <p className="muted small">No patches yet — pick a material and click on the canvas.</p>}
          <ul className="edge-list tall">
            {list.map((p) => (
              <li key={p.id} className="row-between small">
                <button
                  className={p.id === selectedPatchId ? 'active' : ''}
                  onClick={() => {
                    selectPatch(p.id);
                    focusPatch(p.points);
                  }}
                >
                  <strong>{p.id}</strong> · {p.kind} · {p.points.length / 2} pts
                </button>
                <button className="mini" onClick={() => removePatch(p.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </RFlyout>
      </RGroup>
    </>
  );
}

// ── Export ───────────────────────────────────────────────────────────────

const SCALES = [200, 250, 500, 1000, 2000];

export function ExportTab() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const elements = useCst((s) => s.elements);
  const patches = useCst((s) => s.patches);
  const boundaries = useCst((s) => s.boundaries);
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const junctionCorners = useCst((s) => s.settings.junctionCorners);
  const mesh = useCst((s) => s.mesh);
  const kindStyles = useCst((s) => s.kindStyles);
  const exportBounds = useCst((s) => s.exportBounds);
  const boxDraw = useCst((s) => s.boxDraw);
  const setBoxDraw = useCst((s) => s.setBoxDraw);
  const setBox = useCst((s) => s.setBox);

  const [title, setTitle] = useState('Untitled Street Design');
  const [subtitle, setSubtitle] = useState('IRC SP:118-2018 · complete street plan');
  const [scaleDenom, setScaleDenom] = useState(500);

  // The expensive part (full-network derivation + geometry serialization) only
  // depends on the design; framing with the title block is cheap per keystroke.
  const content = useMemo(
    () =>
      planContent(
        { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
        junctionDesigns,
        Object.values(elements),
        Object.values(patches),
        Object.values(boundaries),
        vertexOverrides,
        junctionCorners,
        mesh,
      ),
    // kindStyles: the plan reads the live palette, so a restyle must rebuild it
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, junctionDesigns, elements, patches, boundaries, vertexOverrides, junctionCorners, mesh, kindStyles],
  );
  const plan = useMemo(
    () => framePlanSvg({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }, content, { title, subtitle, scaleDenom }, exportBounds),
    [nodes, edges, content, title, subtitle, scaleDenom, exportBounds],
  );
  const hasContent = Object.keys(edges).length > 0;
  const fileBase = title.replace(/[^\w]+/g, '_').toLowerCase();

  const save = (data: string, type: string, ext: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPdf = () => {
    if (!plan) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      `<!doctype html><html><head><title>${esc(title)}</title>` +
        `<style>@page{size:auto;margin:8mm} body{margin:0} svg{width:100%;height:auto;display:block}</style>` +
        `</head><body>${plan.svg}` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},250)}</scr` +
        `ipt>` +
        `</body></html>`,
    );
    w.document.close();
  };

  const downloadGeoJson = () => {
    const s = useCst.getState();
    if (!s.origin) {
      useCst.setState({ statusMsg: 'GeoJSON needs a map anchor — import from OSM or search a place first' });
      return;
    }
    save(
      buildGeoJson(
        { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
        s.origin,
        junctionDesigns,
        Object.values(elements),
        Object.values(patches),
        Object.values(s.boundaries),
        vertexOverrides,
        junctionCorners,
        mesh,
      ),
      'application/geo+json',
      'geojson',
    );
  };

  return (
    <>
      <RGroup title="Title block">
        <RStack>
          <label className="rb-field">
            Title
            <input className="wide" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="rb-field">
            Subtitle
            <input className="wide" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
          </label>
          <label className="rb-field">
            Scale 1:
            <select value={scaleDenom} onChange={(e) => setScaleDenom(parseInt(e.target.value, 10))}>
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </RStack>
      </RGroup>
      <RGroup title="Extent">
        <RBtn
          icon="▭"
          label={boxDraw === 'export' ? 'Drag on canvas…' : exportBounds ? 'Redraw' : 'Draw extent'}
          title="Drag a box on the canvas to crop the plan to that extent"
          active={boxDraw === 'export'}
          onClick={() => setBoxDraw(boxDraw === 'export' ? null : 'export')}
        />
        <RBtn
          icon="⤢"
          label="Full network"
          title="Export the whole network"
          disabled={!exportBounds}
          onClick={() => setBox('export', null)}
        />
        <span className="rb-info">
          {exportBounds
            ? `${Math.round(exportBounds.maxX - exportBounds.minX)} × ${Math.round(exportBounds.maxY - exportBounds.minY)} m`
            : 'whole network'}
          {plan && (
            <>
              <br />
              page {Math.round(plan.widthMm)} × {Math.round(plan.heightMm)} mm
            </>
          )}
        </span>
      </RGroup>
      <RGroup title="Output">
        <RBtn icon="🖶" label="Print / PDF" title="Open the scaled plan and print it to PDF from the browser" disabled={!plan} onClick={printPdf} />
        <RBtn icon="◇" label="SVG" title="Download the scaled vector plan" disabled={!plan} onClick={() => plan && save(plan.svg, 'image/svg+xml', 'svg')} />
        <RBtn
          icon="{ }"
          label="GeoJSON"
          title="Whole design as WGS84 GeoJSON — centerlines, bands, junctions, elements, boundaries"
          disabled={!hasContent}
          onClick={downloadGeoJson}
        />
        <RFlyout icon="▣" label="Preview" wide disabled={!plan} title="Preview the plan sheet">
          <h3>Preview</h3>
          {plan && <div className="plan-preview" dangerouslySetInnerHTML={{ __html: plan.svg }} />}
        </RFlyout>
        {!hasContent && <span className="rb-info warn">nothing to export yet</span>}
      </RGroup>
    </>
  );
}

// ── View ─────────────────────────────────────────────────────────────────

const BASEMAPS: Array<{ id: Basemap; label: string; icon: string }> = [
  { id: 'none', label: 'None', icon: '▦' },
  { id: 'osm', label: 'OSM', icon: '🗺' },
  { id: 'sat', label: 'Satellite', icon: '🛰' },
];

export function ViewTab({
  onOpen3d,
  onOpenSettings,
  onOpenHelp,
}: {
  onOpen3d: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const basemap = useCst((s) => s.basemap);
  const setBasemap = useCst((s) => s.setBasemap);
  const origin = useCst((s) => s.origin);
  const layers = useCst((s) => s.layers);
  const toggleLayer = useCst((s) => s.toggleLayer);
  const designOpacity = useCst((s) => s.designOpacity);
  const setDesignOpacity = useCst((s) => s.setDesignOpacity);
  const theme = useCst((s) => s.settings.theme);
  const setSetting = useCst((s) => s.setSetting);
  const fitAll = useCst((s) => s.fitAll);

  return (
    <>
      <RGroup title="Basemap">
        {BASEMAPS.map((b) => (
          <RBtn key={b.id} icon={b.icon} label={b.label} active={b.id === basemap} onClick={() => setBasemap(b.id)} />
        ))}
        {basemap !== 'none' && !origin && <span className="rb-info warn">search a place or import to anchor the map</span>}
      </RGroup>
      <RGroup title="Layers">
        <div className="rb-grid">
          {(Object.keys(LAYER_LABELS) as LayerKey[]).map((k) => (
            <label key={k} className="rb-check" title={`${layers[k] ? 'Hide' : 'Show'} ${LAYER_LABELS[k].toLowerCase()}`}>
              <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />
              {LAYER_LABELS[k]}
            </label>
          ))}
        </div>
      </RGroup>
      <RGroup title="Display">
        <RStack>
          <label className="rb-field" title="Design layer transparency (see the basemap through the plan)">
            Design
            <input
              type="range"
              min="15"
              max="100"
              value={Math.round(designOpacity * 100)}
              onChange={(e) => setDesignOpacity(parseInt(e.target.value, 10) / 100)}
            />
          </label>
          <label className="rb-field">
            Theme
            <select value={theme} onChange={(e) => setSetting('theme', e.target.value as typeof theme)}>
              <option value="day">☀ Day</option>
              <option value="night">☾ Night</option>
            </select>
          </label>
        </RStack>
      </RGroup>
      <RGroup title="Navigate">
        <RBtn icon="⤢" label="Fit all" title="Fit the whole network in view (F)" onClick={fitAll} />
        <RBtn icon="◰" label="3D" title="Preview the design in 3D" onClick={onOpen3d} />
      </RGroup>
      <RGroup title="Application">
        <RBtn icon="⚙" label="Settings" title="Theme, traffic side, junction blending, performance" onClick={onOpenSettings} />
        <RBtn icon="?" label="Shortcuts" title="Keyboard shortcuts (?)" onClick={onOpenHelp} />
      </RGroup>
    </>
  );
}
