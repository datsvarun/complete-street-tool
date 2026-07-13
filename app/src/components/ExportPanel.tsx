import { useMemo, useState } from 'react';
import { useCst } from '../store';
import { esc, framePlanSvg, planContent } from '../export/plan';
import { buildGeoJson } from '../export/geojson';

const SCALES = [200, 250, 500, 1000, 2000];

export function ExportPanel() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const elements = useCst((s) => s.elements);
  const patches = useCst((s) => s.patches);
  const boundaries = useCst((s) => s.boundaries);
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const junctionBlend = useCst((s) => s.settings.junctionBlend);
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
        junctionBlend,
      ),
    [nodes, edges, junctionDesigns, elements, patches, boundaries, vertexOverrides, junctionBlend],
  );
  const plan = useMemo(
    () =>
      framePlanSvg(
        { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
        content,
        { title, subtitle, scaleDenom },
        exportBounds,
      ),
    [nodes, edges, content, title, subtitle, scaleDenom, exportBounds],
  );

  const hasContent = Object.keys(edges).length > 0;

  const printPdf = () => {
    if (!plan) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      `<!doctype html><html><head><title>${esc(title)}</title>` +
        `<style>@page{size:auto;margin:8mm} body{margin:0} svg{width:100%;height:auto;display:block}</style>` +
        `</head><body>${plan.svg}` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},250)}</scr` + `ipt>` +
        `</body></html>`,
    );
    w.document.close();
  };

  const download = () => {
    if (!plan) return;
    const blob = new Blob([plan.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w]+/g, '_').toLowerCase()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadGeoJson = () => {
    const s = useCst.getState();
    if (!s.origin) {
      useCst.setState({ statusMsg: 'GeoJSON needs a map anchor — import from OSM or search a place first' });
      return;
    }
    const json = buildGeoJson(
      { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
      s.origin,
      junctionDesigns,
      Object.values(elements),
      Object.values(patches),
      Object.values(s.boundaries),
      vertexOverrides,
      junctionBlend,
    );
    const blob = new Blob([json], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w]+/g, '_').toLowerCase()}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <h2>Export</h2>
      <p className="muted small">
        A scaled vector plan of the whole design — carriageways, junctions,
        sections and detailing. Print to PDF from the browser, or download the
        SVG.
      </p>
      {!hasContent && <p className="muted small">⚠ Nothing to export yet — draw or import a network first.</p>}

      <h3>Title block</h3>
      <label className="small field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="small field">
        Subtitle
        <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
      </label>
      <label className="small field">
        Scale 1:
        <select value={scaleDenom} onChange={(e) => setScaleDenom(parseInt(e.target.value, 10))}>
          {SCALES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <h3>Extent</h3>
      <div className="palette">
        <button
          className={boxDraw === 'export' ? 'chip active' : 'chip'}
          onClick={() => setBoxDraw(boxDraw === 'export' ? null : 'export')}
        >
          {boxDraw === 'export' ? 'Drag on canvas…' : exportBounds ? 'Redraw extent' : 'Draw export extent'}
        </button>
        {exportBounds && (
          <button className="chip" onClick={() => setBox('export', null)}>
            Full network
          </button>
        )}
      </div>
      <p className="muted small">
        {exportBounds
          ? `Exporting ${Math.round(exportBounds.maxX - exportBounds.minX)} × ${Math.round(exportBounds.maxY - exportBounds.minY)} m extent.`
          : 'Exporting the whole network. Draw an extent to crop the plan.'}
      </p>

      <h3>Output</h3>
      <div className="palette">
        <button className="chip" onClick={printPdf} disabled={!plan}>
          Print / Save PDF
        </button>
        <button className="chip" onClick={download} disabled={!plan}>
          Download SVG
        </button>
        <button
          className="chip"
          onClick={downloadGeoJson}
          disabled={!hasContent}
          title="Whole design as WGS84 GeoJSON — centerlines, bands, junctions, elements, boundaries"
        >
          Download GeoJSON
        </button>
      </div>
      {plan && (
        <p className="muted small">
          Page {Math.round(plan.widthMm)} × {Math.round(plan.heightMm)} mm at 1:{scaleDenom}.
        </p>
      )}

      <h3>Preview</h3>
      {plan ? (
        <div className="plan-preview" dangerouslySetInnerHTML={{ __html: plan.svg }} />
      ) : (
        <p className="muted small">Preview appears once the network has geometry.</p>
      )}
    </div>
  );
}
