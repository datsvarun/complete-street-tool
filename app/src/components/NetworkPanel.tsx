import { useMemo, useState } from 'react';
import { useCst, DEFAULT_IMPORT } from '../store';
import { polylineLength } from '../geometry/polyline';
import { validateGraph } from '../graph/validate';

export function NetworkPanel() {
  const tool = useCst((s) => s.tool);
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const dcCandidates = useCst((s) => s.dcCandidates);
  const statusMsg = useCst((s) => s.statusMsg);
  const importBusy = useCst((s) => s.importBusy);
  const setTool = useCst((s) => s.setTool);
  const selectEdge = useCst((s) => s.selectEdge);
  const removeEdge = useCst((s) => s.removeEdge);
  const simplifyAll = useCst((s) => s.simplifyAll);
  const cleanNetwork = useCst((s) => s.cleanNetwork);
  const importOsm = useCst((s) => s.importOsm);
  const loadSample = useCst((s) => s.loadSample);
  const scanDualCarriageways = useCst((s) => s.scanDualCarriageways);
  const applyDcMerge = useCst((s) => s.applyDcMerge);
  const setHighlight = useCst((s) => s.setHighlight);

  const [lat, setLat] = useState(String(DEFAULT_IMPORT.lat));
  const [lon, setLon] = useState(String(DEFAULT_IMPORT.lon));
  const [radius, setRadius] = useState(String(DEFAULT_IMPORT.radiusM));

  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const issues = useMemo(() => validateGraph({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }), [nodes, edges]);
  const selected = selectedEdgeId ? edges[selectedEdgeId] : null;

  return (
    <div className="panel">
      <h2>Network</h2>

      <div className="tool-row">
        <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>
          Select
        </button>
        <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>
          Draw
        </button>
        <button className={tool === 'split' ? 'active' : ''} onClick={() => setTool('split')}>
          Split
        </button>
      </div>

      <h3>Import OSM</h3>
      <div className="field-row">
        <label>
          lat
          <input value={lat} onChange={(e) => setLat(e.target.value)} />
        </label>
        <label>
          lon
          <input value={lon} onChange={(e) => setLon(e.target.value)} />
        </label>
        <label>
          r (m)
          <input value={radius} onChange={(e) => setRadius(e.target.value)} />
        </label>
      </div>
      <div className="tool-row">
        <button
          disabled={importBusy}
          onClick={() => importOsm(parseFloat(lat), parseFloat(lon), parseFloat(radius))}
        >
          Import from OSM
        </button>
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
      <button onClick={() => scanDualCarriageways()}>Find candidates</button>
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
            <button className={e.id === selectedEdgeId ? 'active' : ''} onClick={() => selectEdge(e.id)}>
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
      {selected && (
        <button className="danger" onClick={() => removeEdge(selected.id)}>
          Delete {selected.id}
          {selected.name ? ` (${selected.name})` : ''}
        </button>
      )}
      {statusMsg && <p className="status small">{statusMsg}</p>}
    </div>
  );
}
