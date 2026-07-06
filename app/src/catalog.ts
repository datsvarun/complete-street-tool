import rawCatalog from '../../assets/Codified-IRC-118-2018.json';
import type { ComponentKind, CrossSection } from './types';

// Catalog element names are inconsistent ("Mixed trraffic lane", "Bus Stop / MFZ", ...);
// classify by keyword so every variant gets a stable kind for colouring/legend.
// Check order matters: composite names ("Footpath with Bus Stop/MFZ") resolve to their host component.
export function classifyElement(element: string): ComponentKind {
  const e = element.toLowerCase();
  if (e.includes('footpath')) return 'footpath';
  if (e.includes('cycle')) return 'cycle';
  if (e.includes('bus rapid')) return 'brt';
  if (e.includes('bus stop')) return 'busstop';
  if (e.includes('carriageway')) return 'carriageway';
  if (e.startsWith('mixed')) return 'mixed';
  if (e.includes('service')) return 'service';
  if (e.includes('parking')) return 'parking';
  if (e.includes('mfz')) return 'mfz';
  if (e.includes('muz')) return 'muz';
  if (e.includes('median') || e.includes('verge')) return 'median';
  if (e.includes('tree')) return 'tree';
  if (e.includes('buffer')) return 'buffer';
  if (e.includes('livability')) return 'livability';
  if (e.includes('metro')) return 'metro';
  return 'other';
}

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
  mixed: 'Mixed traffic lane',
  service: 'Service lane',
  brt: 'BRT corridor',
  busstop: 'Bus stop',
  parking: 'Parking',
  cycle: 'Cycle track',
  footpath: 'Footpath',
  muz: 'MUZ',
  mfz: 'MFZ',
  buffer: 'Buffer',
  tree: 'Tree line',
  livability: 'Livability island',
  median: 'Median / verge',
  metro: 'Metro provision',
  other: 'Other',
};

function buildCatalog(): CrossSection[] {
  const sections: CrossSection[] = [];
  for (const group of rawCatalog.row_width_groups) {
    group.street_configurations.forEach((config, i) => {
      const components = config.components.map((c) => ({
        element: c.element,
        widthM: c.width_m,
        kind: classifyElement(c.element),
      }));
      sections.push({
        id: `row${group.row_width_m}-${i}`,
        name: config.street_type_name,
        category: config.street_category,
        rowWidthM: group.row_width_m,
        totalWidthM: components.reduce((s, c) => s + c.widthM, 0),
        components,
      });
    });
  }
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
    .map(([rowWidthM, sections]) => ({ rowWidthM, sections }));
})();

export function getSection(id: string | null): CrossSection | null {
  if (!id) return null;
  return CATALOG.find((s) => s.id === id) ?? null;
}
