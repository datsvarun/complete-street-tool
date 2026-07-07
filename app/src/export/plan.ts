// Stage 4 export: serialize the full design to a self-contained SVG plan.
// Reuses the exact derivation the canvas uses (buildEdgeGeometry, junction
// artifacts, element graphics) so the printed drawing matches the screen.
import type { GraphState, JunctionDesign, StreetElement } from '../types';
import { KIND_COLORS } from '../catalog';
import { buildEdgeGeometry } from '../sections/transition';
import { deriveNodeArtifacts } from '../graph/junctions';
import { elementGraphics, laneDividers } from '../detailing/elements';

export interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

function poly(pts: number[], fill: string, stroke: string, sw: number, dash?: number[]): string {
  const d = pts.map((v, i) => `${num(v)}${i % 2 ? ' ' : ','}`).join('').trim();
  const dashAttr = dash ? ` stroke-dasharray="${dash.join(' ')}"` : '';
  return `<polygon points="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dashAttr}/>`;
}

function pline(pts: number[], stroke: string, sw: number, dash?: number[]): string {
  const d = pts.map((v, i) => `${num(v)}${i % 2 ? ' ' : ','}`).join('').trim();
  const dashAttr = dash ? ` stroke-dasharray="${dash.join(' ')}"` : '';
  return `<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dashAttr}/>`;
}

export function graphBounds(g: GraphState): PlanBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of Object.values(g.nodes)) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** The design as an SVG group (world metres, y-down). No <svg> wrapper. */
export function planContent(
  g: GraphState,
  designs: Record<string, JunctionDesign>,
  elements: StreetElement[],
): string {
  const { junctions, transitions, trims } = deriveNodeArtifacts(g, designs);
  const out: string[] = [];

  // 1. carriageway surface + wedges + noses (junctions under ribbons)
  for (const j of junctions) {
    for (const b of j.coverBands) out.push(poly(b, '#525e6a', 'none', 0));
    out.push(poly(j.polygon, '#525e6a', 'rgba(30,35,40,0.4)', 0.15));
  }

  // 2. edge ribbons (bands + markings), trimmed at junction mouths
  for (const e of Object.values(g.edges)) {
    if (!e.section) continue;
    const { bands, markings } = buildEdgeGeometry(e, trims[e.id]);
    for (const b of bands) out.push(poly(b.polygon, KIND_COLORS[b.kind], 'rgba(30,35,40,0.35)', 0.12));
    for (const m of markings) out.push(pline(m.line, '#f2f0e9', 0.2, m.dashed ? [1, 1] : undefined));
  }

  // 3. junction wedges / noses / transitions on top of ribbons
  for (const j of junctions) {
    for (const b of j.wedges) out.push(poly(b.polygon, KIND_COLORS[b.kind], 'rgba(30,35,40,0.3)', 0.1));
    for (const b of j.noses) out.push(poly(b.polygon, KIND_COLORS[b.kind], 'rgba(30,35,40,0.3)', 0.1));
  }
  for (const t of transitions) {
    for (const b of t.bands) out.push(poly(b.polygon, KIND_COLORS[b.kind], 'rgba(30,35,40,0.35)', 0.12));
  }

  // 4. lane dividers
  for (const e of Object.values(g.edges)) {
    for (const d of laneDividers(e, trims[e.id])) out.push(pline(d, '#f2f0e9', 0.16, [0.6, 0.9]));
  }

  // 5. detailing elements
  for (const el of elements) {
    const edge = g.edges[el.edgeId];
    if (!edge) continue;
    for (const gr of elementGraphics(edge, el)) {
      if (gr.shape === 'circle') {
        out.push(
          `<circle cx="${num(gr.x!)}" cy="${num(gr.y!)}" r="${num(gr.r!)}" fill="${gr.fill ?? 'none'}" stroke="${gr.stroke ?? 'none'}" stroke-width="${num(gr.strokeWidth ?? 0)}"/>`,
        );
      } else if (gr.shape === 'poly') {
        out.push(poly(gr.pts!, gr.fill ?? 'none', gr.stroke ?? 'none', gr.strokeWidth ?? 0));
      } else {
        out.push(pline(gr.pts!, gr.stroke ?? '#000', gr.strokeWidth ?? 0.2, gr.dash));
      }
    }
  }

  return out.join('\n');
}

export interface PlanOptions {
  title: string;
  subtitle: string;
  scaleDenom: number; // 1:scaleDenom (e.g. 500)
  pxPerMm: number;    // rendering density
}

/** Full standalone SVG string: framed plan with title block, legend, scale bar. */
export function buildPlanSvg(
  g: GraphState,
  designs: Record<string, JunctionDesign>,
  elements: StreetElement[],
  opts: PlanOptions,
): { svg: string; widthMm: number; heightMm: number } | null {
  const b = graphBounds(g);
  if (!b) return null;
  const marginM = 8;
  const worldW = b.maxX - b.minX + marginM * 2;
  const worldH = b.maxY - b.minY + marginM * 2;
  // metres → mm on paper: 1 world metre = 1000/scaleDenom mm
  const mmPerM = 1000 / opts.scaleDenom;
  const planWmm = worldW * mmPerM;
  const planHmm = worldH * mmPerM;
  const titleBlockMm = 22;
  const padMm = 10;
  const pageW = planWmm + padMm * 2;
  const pageH = planHmm + padMm * 2 + titleBlockMm;

  const content = planContent(g, designs, elements);

  // Transform: place plan world into a padMm-inset box, scaled by mmPerM.
  const tx = padMm - (b.minX - marginM) * mmPerM;
  const ty = padMm - (b.minY - marginM) * mmPerM;

  // scale bar: a round number of metres
  const barM = niceLength(worldW / 5);
  const barMm = barM * mmPerM;
  const barX = padMm;
  const barY = padMm + planHmm + titleBlockMm - 6;

  const kindsUsed = new Set<string>();
  for (const e of Object.values(g.edges)) e.section?.components.forEach((c) => kindsUsed.add(c.kind));
  const legend = [...kindsUsed]
    .slice(0, 8)
    .map(
      (k, i) =>
        `<rect x="${padMm + 60 + i * 26}" y="${padMm + planHmm + 4}" width="4" height="4" fill="${KIND_COLORS[k as keyof typeof KIND_COLORS]}"/>` +
        `<text x="${padMm + 60 + i * 26 + 5}" y="${padMm + planHmm + 7.6}" font-size="2.6" fill="#333">${esc(k)}</text>`,
    )
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(pageW)}mm" height="${num(pageH)}mm" ` +
    `viewBox="0 0 ${num(pageW)} ${num(pageH)}">` +
    `<rect width="${num(pageW)}" height="${num(pageH)}" fill="#faf8f2"/>` +
    // plan frame
    `<rect x="${padMm}" y="${padMm}" width="${num(planWmm)}" height="${num(planHmm)}" fill="#f0ede4" stroke="#999" stroke-width="0.3"/>` +
    `<g transform="translate(${num(tx)} ${num(ty)}) scale(${num(mmPerM)})">${content}</g>` +
    // title block
    `<g font-family="system-ui, sans-serif">` +
    `<text x="${padMm}" y="${num(padMm + planHmm + 14)}" font-size="5" font-weight="bold" fill="#1c2733">${esc(opts.title)}</text>` +
    `<text x="${padMm}" y="${num(padMm + planHmm + 19)}" font-size="3" fill="#555">${esc(opts.subtitle)}</text>` +
    `<text x="${num(pageW - padMm)}" y="${num(padMm + planHmm + 14)}" font-size="3" fill="#555" text-anchor="end">Scale 1:${opts.scaleDenom}</text>` +
    `<text x="${num(pageW - padMm)}" y="${num(padMm + planHmm + 19)}" font-size="2.6" fill="#999" text-anchor="end">CST · IRC Street Designer</text>` +
    // scale bar
    `<line x1="${num(barX)}" y1="${num(barY)}" x2="${num(barX + barMm)}" y2="${num(barY)}" stroke="#333" stroke-width="0.5"/>` +
    `<line x1="${num(barX)}" y1="${num(barY - 1)}" x2="${num(barX)}" y2="${num(barY + 1)}" stroke="#333" stroke-width="0.5"/>` +
    `<line x1="${num(barX + barMm)}" y1="${num(barY - 1)}" x2="${num(barX + barMm)}" y2="${num(barY + 1)}" stroke="#333" stroke-width="0.5"/>` +
    `<text x="${num(barX + barMm + 2)}" y="${num(barY + 1)}" font-size="2.6" fill="#333">${barM} m</text>` +
    legend +
    `</g></svg>`;

  return { svg, widthMm: pageW, heightMm: pageH };
}

function niceLength(v: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
  const n = v / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}
