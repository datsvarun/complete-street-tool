import { useMemo, useState } from 'react';
import { useCst } from '../store';
import { buildPlanSvg } from '../export/plan';

const SCALES = [200, 250, 500, 1000, 2000];

export function ExportPanel() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const elements = useCst((s) => s.elements);

  const [title, setTitle] = useState('Untitled Street Design');
  const [subtitle, setSubtitle] = useState('IRC SP:118-2018 · complete street plan');
  const [scaleDenom, setScaleDenom] = useState(500);

  const plan = useMemo(
    () =>
      buildPlanSvg(
        { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
        junctionDesigns,
        Object.values(elements),
        { title, subtitle, scaleDenom, pxPerMm: 4 },
      ),
    [nodes, edges, junctionDesigns, elements, title, subtitle, scaleDenom],
  );

  const hasContent = Object.keys(edges).length > 0;

  const printPdf = () => {
    if (!plan) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      `<!doctype html><html><head><title>${title}</title>` +
        `<style>@page{size:auto;margin:8mm} body{margin:0} svg{width:100%;height:auto;display:block}</style>` +
        `</head><body>${plan.svg}` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},250)}</scr` + `ipt>` +
        `</body></html>`,
    );
    w.document.close();
  };

  const download = (ext: 'svg') => {
    if (!plan) return;
    const blob = new Blob([plan.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w]+/g, '_').toLowerCase()}.${ext}`;
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

      <h3>Output</h3>
      <div className="palette">
        <button className="chip" onClick={printPdf} disabled={!plan}>
          Print / Save PDF
        </button>
        <button className="chip" onClick={() => download('svg')} disabled={!plan}>
          Download SVG
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
