// All coordinates are metres in a local planar CRS (x right, y down).
// Lat/lon exists only at import/export boundaries (Plan v2 / CLAUDE.md rule).

export type Stage = 'network' | 'sections' | 'junctions' | 'detailing' | 'export';

export type Tool = 'select' | 'draw' | 'split';

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

export interface GraphNode {
  id: string;
  x: number;
  y: number;
}

/**
 * A section applied to an edge is a materialized COPY of a catalog section
 * (copy-on-write): the strip editor edits it freely without touching the
 * catalog. catalogId keeps provenance for labels/citations.
 */
export interface EdgeSection {
  catalogId: string | null; // null once customized beyond recognition (or hand-built)
  components: SectionComponent[];
}

/**
 * A stretch of an edge carrying a different section than the base. Anchored
 * parametrically by station (Plan v2 §1.2) so it survives geometry edits.
 * Transitions at its boundaries are always derived, never stored (§3.2).
 */
export interface SectionOverride {
  id: string;
  fromM: number; // station along the edge, metres
  toM: number;
  section: EdgeSection;
}

export interface StreetEdge {
  id: string;
  a: string;                 // node id at points[0]
  b: string;                 // node id at points[last]
  points: number[];          // flat [x0, y0, ...] centerline, metres; endpoints mirror node coords
  section: EdgeSection | null;
  overrides?: SectionOverride[];
  highway?: string;          // OSM highway class
  name?: string;
  oneway?: boolean;
  carriagewayType?: 'undivided' | 'divided';
  medianWidth?: number;      // estimate, metres (set by dual-carriageway merge)
}

/** The undoable graph core shared by all stages. */
export interface GraphState {
  nodes: Record<string, GraphNode>;
  edges: Record<string, StreetEdge>;
  nextNodeNum: number;
  nextEdgeNum: number;
}

// Node classification is DERIVED from degree, never stored (Plan v2 §1.3).
export type NodeClass = 'terminus' | 'bend' | 'junction' | 'crossroads';

export function nodeClassOf(degree: number): NodeClass {
  if (degree <= 1) return 'terminus';
  if (degree === 2) return 'bend';
  if (degree === 3) return 'junction';
  return 'crossroads';
}

export interface Snap {
  type: 'node' | 'edge';
  id: string;
  x: number;
  y: number;
}

export interface DraftVert {
  x: number;
  y: number;
  snap: Snap | null;
}

export interface DcCandidate {
  e1: string;
  e2: string;
  meanSepM: number;
  name?: string;
}

export interface ReviewItem {
  edgeId: string;
  reason: string;
}
