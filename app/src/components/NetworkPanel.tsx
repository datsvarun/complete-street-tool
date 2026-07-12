import { useMemo } from 'react';
import { useCst } from '../store';
import { polylineLength } from '../geometry/polyline';
import { validateGraph } from '../graph/validate';

const MAX_IMPORT_KM2 = 3; // keeps the Overpass query and the graph tractable

export function NetworkPanel() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const selectedEdgeIds = useCst((s) => s.selectedEdgeIds);
  const removeEdges = useCst((s) => s.removeEdges);
  const mergeSelectedAsDc = useCst((s) => s.mergeSelectedAsDc);
  const dcCandidates = useCst((s) => s.dcCandidates);
  const statusMsg = useCst((s) => s.statusMsg);
  const importBusy = useCst((s) => s.importBusy);
  const selectEdge = useCst((s) => s.selectEdge);
  const simplifyAll = useCst((s) => s.simplifyAll);
  const cleanNetwork = useCst((s) => s.cleanNetwork);
  const importOsmBbox = useCst((s) => s.importOsmBbox);
  const importFilters = useCst((s) => s.importFilters);
  const setImportFilter = useCst((s) => s.setImportFilter);
  const setBoxDraw = useCst((s) => s.setBoxDraw);
  const boxDraw = useCst((s) => s.boxDraw);
  const importBox = useCst((s) => s.importBox);
  const setBox = useCst((s) => s.setBox);
  const loadSample = useCst((s) => s.loadSample);
  const scanDualCarriageways = useCst((s) => s.scanDualCarriageways);
  const applyDcMerge = useCst((s) => s.applyDcMerge);
  const setHighlight = useCst((s) => s.setHighlight);

  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const issues = useMemo(() => validateGraph({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }), [nodes, edges]);
  const selected = selectedEdgeId ? edges[selectedEdgeId] : null;

  return (
    <div className="panel">
      <h2>Network</h2>

      <h3>Import OSM — by area</h3>
      <p className="muted small">
        Pan/zoom (or search a place) to the area you want, draw a box, confirm,
        and only that extent downloads.
      </p>
      <div className="tool-row">
        <button className={boxDraw === 'import' ? 'active' : ''} onClick={() => setBoxDraw(boxDraw === 'import' ? null : 'import')}>
          {boxDraw === 'import' ? 'Drag on canvas…' : importBox ? 'Redraw area' : 'Draw import area'}
        </button>
        {importBox && (
          <button onClick={() => setBox('import', null)}>Clear</button>
        )}
      </div>
      <div className="filter-row">
        <label title="Keep elevated ways (bridge=*) — off imports the at-grade network only">
          <input
            type="checkbox"
            checked={importFilters.flyovers}
            onChange={(e) => setImportFilter('flyovers', e.target.checked)}
          />
          flyovers
        </label>
        <label title="Keep service alleys and parking aisles">
          <input
            type="checkbox"
            checked={importFilters.serviceRoads}
            onChange={(e) => setImportFilter('serviceRoads', e.target.checked)}
          />
          service lanes
        </label>
        <label title="Also import separate footway/path geometries">
          <input
            type="checkbox"
            checked={importFilters.paths}
            onChange={(e) => setImportFilter('paths', e.target.checked)}
          />
          footpaths
        </label>
      </div>
      {importBox && (() => {
        const wKm = (importBox.maxX - importBox.minX) / 1000;
        const hKm = (importBox.maxY - importBox.minY) / 1000;
        const km2 = wKm * hKm;
        const over = km2 > MAX_IMPORT_KM2;
        return (
          <>
            <p className={over ? 'small issues-inline' : 'muted small'}>
              {(wKm * 1000).toFixed(0)} × {(hKm * 1000).toFixed(0)} m ·{' '}
              {km2 < 0.01 ? `${(km2 * 100).toFixed(1)} ha` : `${km2.toFixed(2)} km²`}
              {over ? ` — too large (max ${MAX_IMPORT_KM2} km²), draw a smaller box` : ''}
            </p>
            <button disabled={over || importBusy} onClick={() => importOsmBbox()}>
              {importBusy ? 'Downloading…' : 'Download this area'}
            </button>
          </>
        );
      })()}

      <div className="tool-row">
        <button disabled={importBusy} onClick={() => loadSample()}>
          Pune sample
        </button>
      </div>
      <p className="muted small">Replaces the current network. Data © OpenStreetMap contributors.</p>

      <h3>Clean</h3>
      <div className="tool-row">
        <button onClick={() => cleanNetwork()}>Collapse short/pass-through</button>
        <button onClick={() => simplifyAll(1)}>Simplify (1 m)</button>
      </div>

      <h3>Dual carriageways</h3>
      <div className="tool-row">
        <button onClick={() => scanDualCarriageways()}>Find candidates</button>
        <button
          disabled={selectedEdgeIds.length !== 2}
          title={selectedEdgeIds.length === 2 ? 'Merge the two selected parallel streets at their midline' : 'Shift-click two parallel streets first'}
          onClick={() => mergeSelectedAsDc()}
        >
          Merge selected (2)
        </button>
      </div>
      {dcCandidates && dcCandidates.length === 0 && <p className="muted small">None detected.</p>}
      {dcCandidates?.map((c) => (
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

      <h3>Validation</h3>
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

      <h3>
        Streets ({edgeList.length}) · nodes {Object.keys(nodes).length}
      </h3>
      {edgeList.length === 0 && (
        <p className="muted">Import an area or pick “Draw” and click on the canvas.</p>
      )}
      <ul className="edge-list">
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
      {selectedEdgeIds.length > 0 && (
        <button className="danger" onClick={() => removeEdges(selectedEdgeIds)}>
          Delete {selectedEdgeIds.length > 1 ? `${selectedEdgeIds.length} streets` : selectedEdgeIds[0]}
          {selectedEdgeIds.length === 1 && selected?.name ? ` (${selected.name})` : ''}
        </button>
      )}
      {statusMsg && <p className="status small">{statusMsg}</p>}
    </div>
  );
}
