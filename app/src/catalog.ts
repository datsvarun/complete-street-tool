import rawCatalog from '../../assets/Codified-IRC-118-2018.json';
import type { ComponentKind, CrossSection } from './types';

// Catalog element names are inconsistent ("Mixed trraffic lane", "Bus Stop / MFZ", ...);
// classify by keyword so every variant gets a stable kind for colouring/legend.
// Check order matters: composite names ("Footpath with Bus Stop/MFZ") resolve to their host component.
// Kind merges (user decision): MFZ and Bus Stop/MFZ fold into MUZ — one
// multi-utility zone concept. 'mfz'/'busstop' stay in ComponentKind so old
// saved documents still render, but the catalog no longer emits them.
export function classifyElement(element: string): ComponentKind {
  const e = element.toLowerCase();
  if (e.includes('footpath')) return 'footpath';
  if (e.includes('cycle')) return 'cycle';
  if (e.includes('bus rapid')) return 'brt';
  if (e.includes('bus stop')) return 'muz';
  if (e.includes('carriageway')) return 'carriageway';
  if (e.startsWith('mixed')) return 'mixed';
  if (e.includes('service')) return 'service';
  if (e.includes('parking')) return 'parking';
  if (e.includes('mfz')) return 'muz';
  if (e.includes('muz')) return 'muz';
  if (e.includes('median') || e.includes('verge')) return 'median';
  if (e.includes('tree')) return 'tree';
  if (e.includes('buffer')) return 'buffer';
  if (e.includes('livability')) return 'livability';
  if (e.includes('metro')) return 'metro';
  return 'other';
}

/** Display-name normalization applied to every catalog element ("wherever
 *  seen"): MFZ variants → MUZ, Tree Line → Green Buffer, mixed lane → Bus lane. */
export function normalizeElementName(element: string): string {
  const e = element.toLowerCase();
  if (e.includes('bus stop') || e.includes('mfz')) return 'MUZ';
  if (e.includes('tree')) return 'Green Buffer';
  if (e.startsWith('mixed')) return 'Bus lane';
  return element;
}

/** Components flush with the carriageway (parking is at-grade in Indian
 *  practice). Defines the curb line for junction geometry AND element
 *  placement — one set so they can never disagree. */
export const DRIVABLE_KINDS: Set<ComponentKind> = new Set([
  'carriageway', 'mixed', 'service', 'brt', 'parking',
]);

export const KIND_COLORS: Record<ComponentKind, string> = {
  carriageway: '#4a5560',
  mixed: '#5d6873',
  service: '#7a8590',
  brt: '#8f4e49',
  busstop: '#d3a24f',
  parking: '#9aa7b4',
  cycle: '#4f9d69',
  footpath: '#e3ded1',
  muz: '#c8b48e',
  mfz: '#d3b878',
  buffer: '#8fb07a',
  tree: '#6f9e5c',
  livability: '#a9c48f',
  median: '#5f7d4f',
  metro: '#a79ec2',
  other: '#c7c7c7',
};

export const KIND_LABELS: Record<ComponentKind, string> = {
  carriageway: 'Carriageway',
  mixed: 'Bus lane',
  service: 'Service lane',
  brt: 'BRT corridor',
  busstop: 'MUZ', // merged (legacy documents only)
  parking: 'Parking',
  cycle: 'Cycle track',
  footpath: 'Footpath',
  muz: 'MUZ',
  mfz: 'MUZ', // merged (legacy documents only)
  buffer: 'Buffer',
  tree: 'Green buffer',
  livability: 'Livability island',
  median: 'Median / verge',
  metro: 'Metro provision',
  other: 'Other',
};

const r2 = (v: number) => Math.round(v * 20) / 20; // 5 cm steps

/** "Standard road" per ROW: rule of thirds — one third to sidewalks, a 0.6 m
 *  median on 12 m+, the rest carriageway. Very small ROWs get a single-side
 *  footpath instead. */
function standardSection(rowM: number): CrossSection {
  const components: CrossSection['components'] = [];
  const fp = (w: number) => ({ element: 'Footpath', widthM: r2(w), kind: 'footpath' as ComponentKind });
  const cw = (w: number) => ({ element: 'Carriageway', widthM: r2(w), kind: 'carriageway' as ComponentKind });
  if (rowM < 9) {
    // small section: footpath one side only
    const walk = Math.max(1.8, r2(rowM / 3));
    components.push(fp(walk), cw(rowM - walk));
  } else if (rowM < 12) {
    const walk = r2(rowM / 3 / 2);
    components.push(fp(walk), cw(rowM - walk * 2), fp(walk));
  } else {
    const walk = r2(rowM / 3 / 2);
    const median = 0.6;
    const half = r2((rowM - walk * 2 - median) / 2);
    components.push(fp(walk), cw(half), {
      element: 'Median',
      widthM: median,
      kind: 'median',
    }, cw(half), fp(walk));
  }
  return {
    id: `std${rowM}`,
    name: `${rowM}m Standard road`,
    label: `${rowM}m Standard`,
    source: 'std',
    category: 'standard',
    rowWidthM: rowM,
    totalWidthM: components.reduce((s, c) => s + c.widthM, 0),
    components,
  };
}

function buildCatalog(): CrossSection[] {
  const sections: CrossSection[] = [];
  const rows = new Set<number>();
  for (const group of rawCatalog.row_width_groups) {
    rows.add(group.row_width_m);
    group.street_configurations.forEach((config, i) => {
      const components = config.components.map((c) => ({
        element: normalizeElementName(c.element),
        widthM: c.width_m,
        kind: classifyElement(c.element),
      }));
      sections.push({
        id: `row${group.row_width_m}-${i}`,
        name: config.street_type_name,
        label: `${group.row_width_m}m IRC (${i + 1})`,
        source: 'irc',
        category: config.street_category,
        rowWidthM: group.row_width_m,
        totalWidthM: components.reduce((s, c) => s + c.widthM, 0),
        components,
      });
    });
  }
  // one Standard road per ROW, listed first in each group
  for (const rowM of rows) sections.push(standardSection(rowM));
  return sections;
}

export const CATALOG: CrossSection[] = buildCatalog();

export const CATALOG_BY_ROW: Array<{ rowWidthM: number; sections: CrossSection[] }> = (() => {
  const rows = new Map<number, CrossSection[]>();
  for (const s of CATALOG) {
    const list = rows.get(s.rowWidthM) ?? [];
    list.push(s);
    rows.set(s.rowWidthM, list);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rowWidthM, sections]) => ({
      rowWidthM,
      // Standard road first, then IRC configs in catalog order
      sections: [...sections].sort((a, b) => (a.source === 'std' ? -1 : b.source === 'std' ? 1 : 0)),
    }));
})();

export function getSection(id: string | null): CrossSection | null {
  if (!id) return null;
  return CATALOG.find((s) => s.id === id) ?? null;
}
