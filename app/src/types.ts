// All coordinates are metres in a local planar CRS (x right, y down).
// Lat/lon exists only at import/export boundaries (Plan v2 / CLAUDE.md rule).

export type Stage = 'network' | 'sections' | 'junctions' | 'detailing' | 'export';

export type Tool = 'select' | 'draw';

export type ComponentKind =
  | 'carriageway'
  | 'mixed'
  | 'service'
  | 'brt'
  | 'busstop'
  | 'parking'
  | 'cycle'
  | 'footpath'
  | 'muz'
  | 'mfz'
  | 'buffer'
  | 'tree'
  | 'livability'
  | 'median'
  | 'metro'
  | 'other';

export interface SectionComponent {
  element: string;   // verbatim name from the IRC catalog
  widthM: number;
  kind: ComponentKind;
}

export interface CrossSection {
  id: string;
  name: string;
  category: string;
  rowWidthM: number;    // ROW group the catalog places this under
  totalWidthM: number;  // sum of component widths (may differ from ROW — catalog data quirks)
  components: SectionComponent[]; // ordered left → right across the street
}

export interface StreetEdge {
  id: string;
  points: number[];          // flat [x0, y0, x1, y1, ...] centerline vertices, metres
  sectionId: string | null;  // assigned CrossSection, null = centerline only
}
