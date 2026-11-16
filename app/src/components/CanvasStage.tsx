import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle, Ring, Rect, Arrow, Group, Shape } from 'react-konva';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCst } from '../store';
import { KIND_COLORS } from '../catalog';
import { refFraction } from '../geometry/ribbon';
import { Basemap } from './Basemap';
import { buildEdgeGeometry } from '../sections/transition';
import { offsetPolyline, projectOnPolyline, dist, toFlat, toPts, pointInPolygon } from '../geometry/polyline';
import { BasemapFab, ScaleBar, CompassRose, LayerRail } from './FloatingUI';
import { PropertiesSidebar } from './PropertiesSidebar';
import { nodeClassOf } from '../types';
import type { Boundary, GraphNode, Patch, Snap, StreetEdge, StreetElement, Tool } from '../types';
import { bandDecals, elementGraphics, laneDividers } from '../detailing/elements';
import { edgesInRect, edgesNear } from '../geometry/spatialIndex';
import { applyShapeOverrides } from '../cad/vertexOverrides';
import { weldMapFor, weldedDragDeltas } from '../cad/mesh';
import type { MeshMember } from '../cad/mesh';
import { degree } from '../graph/ops';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import type { EdgeTrim, JunctionPoly, NodeArtifacts } from '../graph/junctions';
import { circleFrom3 } from '../mesh/engine';
import type { Mesh, MeshFace } from '../mesh/engine';

Konva.dragDistance = 3; // don't treat a pan drag as a click
// Touch: keep hit detection alive while a finger drags, so the second finger
// of a pinch is seen (standard Konva mobile recipe).
Konva.hitOnDragEnabled = true;

/** Pointer position in world metres — the ONE screen→world conversion. */
function stageToWorld(stageNode: Konva.Stage): { x: number; y: number } | null {
  const pos = stageNode.getPointerPosition();
  if (!pos) return null;
  return {
    x: (pos.x - stageNode.x()) / stageNode.scaleX(),
    y: (pos.y - stageNode.y()) / stageNode.scaleY(),
  };
}

interface View {
  x: number;
  y: number;
  scale: number; // px per metre
}

const GRID_STEP = 10; // metres
const MIN_SCALE = 0.2;
const MAX_SCALE = 60;
const SNAP_PX = 8;       // Plan v2 §2.2: screen-space snap radius
const NODE_MERGE_PX = 10;

// ── Rendering performance (see ARCHITECTURE §8) ──────────────────────────
// LOD: below this px/m, fine detail (markings, dividers, furniture, band
// strokes) is sub-pixel — drawing it costs frames and shows nothing.
const DETAIL_SCALE = 1.2;
// Viewport culling kicks in above this edge count (below it, filtering costs
// more than it saves). Rect padded so small pans don't pop geometry.
const CULL_MIN_EDGES = 60;
const CULL_PAD = 0.4; // fraction of the larger viewport dimension

const NODE_COLORS = {
  terminus: '#4CAF50',
  bend: '#2196F3',
  junction: '#FF9800',
  crossroads: '#F44336',
} as const;

/** One handler for mouse click AND touch tap (Konva fires them separately).
 *  Touch events lack modifier keys — handlers already treat those as falsy. */
function pressable(h: (e: KonvaEventObject<MouseEvent>) => void) {
  return { onClick: h, onTap: h as unknown as (e: KonvaEventObject<TouchEvent>) => void };
}

/** Reactive hover cursor: set on enter, clear on leave (falls back to the
 *  container's tool cursor). */
function hoverCursor(cur: string) {
  return {
    onMouseEnter: (e: KonvaEventObject<MouseEvent>) => {
      const el = e.target.getStage()?.container();
      if (el) el.style.cursor = cur;
    },
    onMouseLeave: (e: KonvaEventObject<MouseEvent>) => {
      const el = e.target.getStage()?.container();
      if (el) el.style.cursor = '';
    },
  };
}

function GridLayerImpl({ view, width, height }: { view: View; width: number; height: number }) {
  const lines = useMemo(() => {
    const x0 = -view.x / view.scale;
    const y0 = -view.y / view.scale;
    const x1 = x0 + width / view.scale;
    const y1 = y0 + height / view.scale;
    const step = view.scale > 2 ? GRID_STEP : GRID_STEP * 10;
    const out: Array<{ key: string; pts: number[]; axis: boolean }> = [];
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      out.push({ key: `v${x}`, pts: [x, y0, x, y1], axis: x === 0 });
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      out.push({ key: `h${y}`, pts: [x0, y, x1, y], axis: y === 0 });
    }
    return out;
  }, [view, width, height]);

  return (
    <Layer listening={false}>
      {lines.map((l) => (
        <Line
          key={l.key}
          points={l.pts}
          stroke={l.axis ? '#c9c3b4' : '#e6e2d6'}
          strokeWidth={1}
          strokeScaleEnabled={false}
        />
      ))}
    </Layer>
  );
}
const GridLayer = memo(GridLayerImpl);

const HIGHWAY_WIDTH: Record<string, number> = {
  motorway: 3, trunk: 3, primary: 2.6, secondary: 2.3, tertiary: 2,
  unclassified: 1.6, residential: 1.6, service: 1, living_street: 1.4, pedestrian: 1.4,
};

function edgeStroke(e: StreetEdge, selected: boolean, highlighted: boolean, hasSection: boolean) {
  if (selected) return { stroke: '#e08e45', width: 3 };
  if (highlighted) return { stroke: '#c93cbc', width: 3.5 };
  if (hasSection) return { stroke: 'rgba(255,255,255,0.85)', width: 1.2 };
  if (e.carriagewayType === 'divided') return { stroke: '#155a8a', width: 3 };
  const w = HIGHWAY_WIDTH[e.highway ?? ''] ?? 2;
  return { stroke: e.oneway ? '#5a3f80' : '#1c2733', width: w };
}

function EdgeShape({
  edge,
  selected,
  highlighted,
  tool,
  showSections,
  trim,
  showDetail,
}: {
  edge: StreetEdge;
  selected: boolean;
  highlighted: boolean;
  tool: Tool;
  showSections: boolean;
  trim?: EdgeTrim;
  showDetail: boolean;
}) {
  const selectEdge = useCst((s) => s.selectEdge);
  const splitEdgeAt = useCst((s) => s.splitEdgeAt);
  const section = edge.section;
  const { bands: baseBands, markings } = useMemo(
    () => (showSections ? buildEdgeGeometry(edge, trim) : { bands: [], markings: [] }),
    [edge, showSections, trim],
  );
  // CAD vertex overrides (whole record — its reference only changes when an
  // override changes). Untouched edges keep their memoized baseBands identity.
  const allOverrides = useCst((s) => s.vertexOverrides);
  const bands = useMemo(() => {
    let touched = false;
    const out = baseBands.map((b) => {
      const ov = allOverrides[`band:${edge.id}:${b.key}`];
      if (!ov) return b;
      touched = true;
      return { ...b, polygon: applyShapeOverrides(b.polygon, ov) };
    });
    return touched ? out : baseBands;
  }, [baseBands, allOverrides, edge.id]);
  // Network view: dotted ROW outlines so the section stays referenceable
  // while editing the graph.
  const outline = useMemo(() => {
    if (showSections || !section) return null;
    const total = section.components.reduce((s, c) => s + c.widthM, 0);
    const base = total * refFraction(section);
    const pts = toPts(edge.points);
    return [toFlat(offsetPolyline(pts, base)), toFlat(offsetPolyline(pts, base - total))];
  }, [edge.points, section, showSections]);
  const onClick = (e: KonvaEventObject<MouseEvent>) => {
    const st = useCst.getState();
    // Boundary tracing / box drawing own every click — let it bubble to the
    // stage handler instead of selecting the street underneath.
    if (st.boundaryDraw || st.boxDraw) return;
    // Detailing: a click on the ribbon should place/select an element, not fall
    // through to edge selection — the band would otherwise eat the placement.
    if (st.stage === 'detailing') {
      e.cancelBubble = true;
      const stageNode = e.target.getStage()!;
      const w = stageToWorld(stageNode);
      if (!w) return;
      if (st.placeKind) st.placeElementAt(w.x, w.y, 40 / stageNode.scaleX());
      else selectEdge(edge.id, e.evt.shiftKey ? 'add' : e.evt.ctrlKey || e.evt.metaKey ? 'toggle' : 'replace');
      return;
    }
    if (tool === 'select') {
      e.cancelBubble = true;
      selectEdge(edge.id, e.evt.shiftKey ? 'add' : e.evt.ctrlKey || e.evt.metaKey ? 'toggle' : 'replace');
    } else if (tool === 'split') {
      e.cancelBubble = true;
      const stageNode = e.target.getStage()!;
      const w = stageToWorld(stageNode);
      if (w) splitEdgeAt(edge.id, w.x, w.y);
    } else if (tool === 'erase') {
      e.cancelBubble = true;
      st.removeEdges([edge.id]);
    }
  };
  const s = edgeStroke(edge, selected, highlighted, showSections && !!section);

  // Edit stage: clicking a generated band selects it for vertex editing.
  const onBandClick = (e: KonvaEventObject<MouseEvent>, bandKey: string) => {
    const st = useCst.getState();
    if (st.stage === 'edit' && !st.patchKind && !st.boundaryDraw && !st.boxDraw) {
      e.cancelBubble = true;
      st.selectShape(`band:${edge.id}:${bandKey}`);
      st.selectPatch(null);
      return;
    }
    onClick(e);
  };

  return (
    <>
      {bands.map((b) => (
        <Line
          key={`${edge.id}-${b.key}`}
          points={b.polygon}
          closed
          fill={KIND_COLORS[b.kind]}
          // LOD: band hairlines are invisible below DETAIL_SCALE; skipping the
          // stroke pass (and its per-shape transform reset) is a big draw win.
          stroke={showDetail ? 'rgba(30,35,40,0.35)' : undefined}
          strokeWidth={0.6}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          {...pressable((e) => onBandClick(e, b.key))}
          {...hoverCursor('pointer')}
        />
      ))}
      {outline?.map((o, i) => (
        <Line
          key={`${edge.id}-out${i}`}
          points={o}
          stroke="rgba(70,84,98,0.55)"
          strokeWidth={1}
          dash={[3, 4]}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          listening={false}
        />
      ))}
      {showDetail &&
        markings.map((m) => (
          <Line
            key={`${edge.id}-${m.key}`}
            points={m.line}
            stroke="#f2f0e9"
            strokeWidth={1}
            dash={m.dashed ? [4, 4] : undefined}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            listening={false}
          />
        ))}
      <Line
        points={edge.points}
        stroke={s.stroke}
        strokeWidth={s.width}
        dash={showSections && section && !selected ? [6, 6] : edge.carriagewayType === 'divided' ? [10, 4] : undefined}
        strokeScaleEnabled={false}
        hitStrokeWidth={12}
        {...pressable(onClick)}
        {...hoverCursor('pointer')}
      />
    </>
  );
}

function EdgesLayerImpl({
  edges,
  selectedEdgeIds,
  highlightEdges,
  tool,
  showSections,
  trims,
  opacity,
  showDetail,
}: {
  edges: StreetEdge[];
  selectedEdgeIds: string[];
  highlightEdges: string[];
  tool: Tool;
  showSections: boolean;
  trims: Record<string, EdgeTrim>;
  opacity: number;
  showDetail: boolean;
}) {
  return (
    <Layer opacity={opacity}>
      {edges.map((e) => (
        <EdgeShape
          key={e.id}
          edge={e}
          selected={selectedEdgeIds.includes(e.id)}
          highlighted={highlightEdges.includes(e.id)}
          tool={tool}
          showSections={showSections}
          trim={trims[e.id]}
          showDetail={showDetail}
        />
      ))}
    </Layer>
  );
}
const EdgesLayer = memo(EdgesLayerImpl);

function NodesLayerImpl({
  nodes,
  degrees,
  scale,
  draggable,
}: {
  nodes: GraphNode[];
  degrees: Record<string, number>;
  scale: number;
  draggable: boolean;
}) {
  const moveNodeTo = useCst((s) => s.moveNodeTo);
  const mergeNodePair = useCst((s) => s.mergeNodePair);
  const weldNodeToEdge = useCst((s) => s.weldNodeToEdge);
  const removeNodeSmart = useCst((s) => s.removeNodeSmart);
  const [dragSnap, setDragSnap] = useState<{ x: number; y: number; kind: 'node' | 'edge' } | null>(null);
  const r = 3.5 / scale;

  const snapUnderDrag = (nodeId: string, x: number, y: number) => {
    const tol = NODE_MERGE_PX / scale;
    const state = useCst.getState();
    const g = { nodes: state.nodes, edges: state.edges, nextNodeNum: 0, nextEdgeNum: 0 };
    const cands = edgesNear(g, x, y, tol);
    for (const e of cands) {
      for (const nid of [e.a, e.b]) {
        const m = state.nodes[nid];
        if (m && m.id !== nodeId && dist(m.x, m.y, x, y) < tol) {
          return { x: m.x, y: m.y, kind: 'node' as const };
        }
      }
    }
    for (const e of cands) {
      if (e.a === nodeId || e.b === nodeId) continue;
      const proj = projectOnPolyline(e.points, x, y);
      if (proj && proj.dist < tol) return { x: proj.x, y: proj.y, kind: 'edge' as const };
    }
    return null;
  };

  return (
    <Layer>
      {nodes.map((n) => (
        <Circle
          key={n.id}
          x={n.x}
          y={n.y}
          radius={Math.max(r, 0.4)}
          fill={NODE_COLORS[nodeClassOf(degrees[n.id] ?? 0)]}
          stroke="#14181d"
          strokeWidth={1}
          strokeScaleEnabled={false}
          draggable={draggable}
          onContextMenu={(e) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            removeNodeSmart(n.id);
          }}
          {...pressable((e) => {
            if (useCst.getState().tool !== 'erase') return;
            e.cancelBubble = true;
            removeNodeSmart(n.id);
          })}
          {...hoverCursor('move')}
          onDragStart={(e) => {
            // moving a graph node invalidates a frozen mesh — confirm first
            if (!useCst.getState().guardMeshEdit()) {
              e.target.stopDrag();
              e.target.position({ x: n.x, y: n.y });
              return;
            }
            useCst.temporal.getState().pause();
          }}
          onDragMove={(e) => {
            moveNodeTo(n.id, e.target.x(), e.target.y());
            setDragSnap(snapUnderDrag(n.id, e.target.x(), e.target.y()));
          }}
          onDragEnd={(e) => {
            setDragSnap(null);
            useCst.temporal.getState().resume();
            const x = e.target.x();
            const y = e.target.y();
            moveNodeTo(n.id, x, y);
            // Drop onto another node → merge; onto an edge → split + weld
            // (Plan v2 §2.3 cleaning toolkit)
            const tol = NODE_MERGE_PX / scale;
            const state = useCst.getState();
            const target = Object.values(state.nodes).find(
              (m) => m.id !== n.id && dist(m.x, m.y, x, y) < tol,
            );
            if (target) {
              mergeNodePair(target.id, n.id);
              return;
            }
            let bestEdge: { id: string; d: number } | null = null;
            for (const e of Object.values(state.edges)) {
              if (e.a === n.id || e.b === n.id) continue; // not its own streets
              const proj = projectOnPolyline(e.points, x, y);
              if (proj && proj.dist < tol && (!bestEdge || proj.dist < bestEdge.d)) {
                bestEdge = { id: e.id, d: proj.dist };
              }
            }
            if (bestEdge) weldNodeToEdge(n.id, bestEdge.id, x, y);
          }}
        />
      ))}
      {dragSnap && (
        <Ring
          x={dragSnap.x}
          y={dragSnap.y}
          innerRadius={4.5 / scale}
          outerRadius={7 / scale}
          fill={dragSnap.kind === 'node' ? '#0a8f4b' : '#b3541e'}
          listening={false}
        />
      )}
    </Layer>
  );
}
const NodesLayer = memo(NodesLayerImpl);

/** Interior polyline vertices (OSM way bends that aren't graph nodes):
 *  draggable to reshape the street, right-click to remove. */
function VerticesLayerImpl({
  edges,
  scale,
  draggable,
}: {
  edges: StreetEdge[];
  scale: number;
  draggable: boolean;
}) {
  const moveVertex = useCst((s) => s.moveVertex);
  const removeVertex = useCst((s) => s.removeVertex);
  const r = 2.4 / scale;
  return (
    <Layer>
      {edges.flatMap((e) => {
        const n = e.points.length / 2;
        const out = [] as React.ReactNode[];
        for (let i = 1; i < n - 1; i++) {
          out.push(
            <Circle
              key={`${e.id}-v${i}`}
              x={e.points[i * 2]}
              y={e.points[i * 2 + 1]}
              radius={Math.max(r, 0.3)}
              fill="#ffffff"
              stroke="#5a6674"
              strokeWidth={1}
              strokeScaleEnabled={false}
              draggable={draggable}
              {...(draggable ? hoverCursor('move') : {})}
              onContextMenu={(ev) => {
                ev.evt.preventDefault();
                ev.cancelBubble = true;
                removeVertex(e.id, i);
              }}
              {...pressable((ev) => {
                if (useCst.getState().tool !== 'erase') return;
                ev.cancelBubble = true;
                removeVertex(e.id, i);
              })}
              onDragStart={(ev) => {
                if (!useCst.getState().guardMeshEdit()) {
                  ev.target.stopDrag();
                  ev.target.position({ x: e.points[i * 2], y: e.points[i * 2 + 1] });
                  return;
                }
                useCst.temporal.getState().pause();
              }}
              onDragMove={(ev) => moveVertex(e.id, i, ev.target.x(), ev.target.y())}
              onDragEnd={(ev) => {
                useCst.temporal.getState().resume();
                moveVertex(e.id, i, ev.target.x(), ev.target.y());
              }}
            />,
          );
        }
        return out;
      })}
    </Layer>
  );
}
const VerticesLayer = memo(VerticesLayerImpl);

/** Unified snap over the spatial index: node endpoints, then interior polyline
 *  vertices, then edge projections — all from local candidates only (P1). */
function findSnap(
  wx: number,
  wy: number,
  tol: number,
  nodes: Record<string, GraphNode>,
  edges: Record<string, StreetEdge>,
): Snap | null {
  const g = { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 };
  const cands = edgesNear(g, wx, wy, tol);
  let best: Snap | null = null;
  let bestD = tol;
  const seen = new Set<string>();
  for (const e of cands) {
    for (const nid of [e.a, e.b]) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const n = nodes[nid];
      if (!n) continue;
      const d = dist(n.x, n.y, wx, wy);
      if (d < bestD) {
        bestD = d;
        best = { type: 'node', id: n.id, x: n.x, y: n.y };
      }
    }
  }
  if (best) return best;
  for (const e of cands) {
    // interior vertices snap like edge points (drafts split there exactly)
    for (let i = 2; i + 3 < e.points.length; i += 2) {
      const d = dist(e.points[i], e.points[i + 1], wx, wy);
      if (d < bestD) {
        bestD = d;
        best = { type: 'edge', id: e.id, x: e.points[i], y: e.points[i + 1] };
      }
    }
  }
  if (best) return best;
  for (const e of cands) {
    const proj = projectOnPolyline(e.points, wx, wy);
    if (proj && proj.dist < bestD) {
      bestD = proj.dist;
      best = { type: 'edge', id: e.id, x: proj.x, y: proj.y };
    }
  }
  return best;
}

/** One street element: memo'd so dragging one element (or changing the
 *  selection) doesn't recompute graphics for the other thousand. */
function ElementShapeImpl({
  el,
  edge,
  interactive,
  selected,
}: {
  el: StreetElement;
  edge: StreetEdge;
  interactive: boolean;
  selected: boolean;
}) {
  const moveElement = useCst((s) => s.moveElement);
  const removeElement = useCst((s) => s.removeElement);
  const selectElement = useCst((s) => s.selectElement);
  const gfx = useMemo(() => elementGraphics(edge, el), [edge, el]);
  if (gfx.length === 0) return null;
  return (
    <Group
      draggable={interactive}
      {...(interactive ? hoverCursor('move') : {})}
      opacity={el.placedBy === 'suggest' ? 0.75 : 1}
      {...pressable((ev) => {
        if (!interactive) return;
        ev.cancelBubble = true;
        selectElement(el.id);
      })}
      onDragStart={() => useCst.temporal.getState().pause()}
      onDragMove={(ev) => {
        const w = stageToWorld(ev.target.getStage()!);
        if (!w) return;
        moveElement(el.id, w.x, w.y, 40);
        ev.target.position({ x: 0, y: 0 });
      }}
      onDragEnd={(ev) => {
        useCst.temporal.getState().resume();
        ev.target.position({ x: 0, y: 0 });
      }}
      onContextMenu={(ev) => {
        ev.evt.preventDefault();
        ev.cancelBubble = true;
        removeElement(el.id);
      }}
    >
      {selected &&
        (() => {
          // shape-fitting selection outline (not a floating circle)
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const g of gfx) {
            if (g.shape === 'circle') {
              minX = Math.min(minX, g.x! - g.r!); maxX = Math.max(maxX, g.x! + g.r!);
              minY = Math.min(minY, g.y! - g.r!); maxY = Math.max(maxY, g.y! + g.r!);
            } else if (g.pts) {
              for (let i = 0; i + 1 < g.pts.length; i += 2) {
                minX = Math.min(minX, g.pts[i]); maxX = Math.max(maxX, g.pts[i]);
                minY = Math.min(minY, g.pts[i + 1]); maxY = Math.max(maxY, g.pts[i + 1]);
              }
            }
          }
          if (!Number.isFinite(minX)) return null;
          const pad = 0.4;
          return (
            <Rect
              x={minX - pad}
              y={minY - pad}
              width={maxX - minX + pad * 2}
              height={maxY - minY + pad * 2}
              stroke="#e08e45"
              strokeWidth={1.5}
              dash={[4, 3]}
              strokeScaleEnabled={false}
              listening={false}
            />
          );
        })()}
      {gfx.map((g, gi) =>
        g.shape === 'circle' ? (
          <Circle
            key={gi}
            x={g.x}
            y={g.y}
            radius={g.r}
            fill={g.fill}
            stroke={g.stroke}
            strokeWidth={g.strokeWidth}
            perfectDrawEnabled={false}
          />
        ) : (
          <Line
            key={gi}
            points={g.pts}
            closed={g.closed}
            fill={g.fill}
            stroke={g.stroke}
            strokeWidth={g.strokeWidth ?? 0}
            dash={g.dash}
            perfectDrawEnabled={false}
          />
        ),
      )}
    </Group>
  );
}
const ElementShape = memo(ElementShapeImpl);

/** Stage 3 elements: parametric symbols that drag along/across their edge but
 *  stay inside the component kinds their element type allows. */
function DetailingLayerImpl({
  elements,
  edges,
  trims,
  interactive,
  selectedElementId,
  dividerEdges,
  showDetail,
}: {
  elements: StreetElement[];
  edges: Record<string, StreetEdge>;
  trims: Record<string, EdgeTrim>;
  interactive: boolean;
  selectedElementId: string | null;
  dividerEdges: StreetEdge[];
  showDetail: boolean;
}) {
  const dividers = useMemo(
    () =>
      showDetail
        ? dividerEdges.flatMap((e) =>
            laneDividers(e, trims[e.id]).map((pts, i) => ({ key: `${e.id}-lane${i}`, pts })),
          )
        : [],
    [dividerEdges, trims, showDetail],
  );
  // parametric decals: parking bay ticks + cycle chevrons (derived per section)
  const decals = useMemo(
    () =>
      showDetail
        ? dividerEdges.flatMap((e, ei) => bandDecals(e, trims[e.id]).map((g, i) => ({ key: `${ei}-d${i}`, g })))
        : [],
    [dividerEdges, trims, showDetail],
  );

  return (
    <Layer listening={interactive}>
      {dividers.map((d) => (
        <Line
          key={d.key}
          points={d.pts}
          stroke="#f2f0e9"
          strokeWidth={0.8}
          dash={[3, 4.5]}
          strokeScaleEnabled={false}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
      {decals.map((d) => (
        <Line
          key={d.key}
          points={d.g.pts}
          stroke={d.g.stroke}
          strokeWidth={(d.g.strokeWidth ?? 0.15) * 2}
          strokeScaleEnabled={false}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
      {elements.map((el) => {
        const edge = edges[el.edgeId];
        if (!edge) return null;
        // LOD: point furniture and arrows are sub-pixel below DETAIL_SCALE;
        // crossings/driveways are structural — always shown.
        if (!showDetail && el.kind !== 'zebra' && el.kind !== 'raisedcrossing' && el.kind !== 'driveway') {
          return null;
        }
        return (
          <ElementShape
            key={el.id}
            el={el}
            edge={edge}
            interactive={interactive}
            selected={el.id === selectedElementId}
          />
        );
      })}
    </Layer>
  );
}
const DetailingLayer = memo(DetailingLayerImpl);

/** Junction surfaces, wedges/noses and node transitions — memo'd so mousemove
 *  state (cursor coords) doesn't reconcile hundreds of Konva shapes. */
function ArtifactsLayerImpl({
  artifacts,
  stage,
  selectedJunctionKey,
  designOpacity,
  dimOthers,
  showDetail,
}: {
  artifacts: NodeArtifacts;
  stage: string;
  selectedJunctionKey: string | null;
  designOpacity: number;
  dimOthers: boolean;
  showDetail: boolean;
}) {
  const selectJunction = useCst((s) => s.selectJunction);
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const junctionsStage = stage === 'junctions';
  const editStage = stage === 'edit';
  const selectShape = (key: string) => {
    const st = useCst.getState();
    if (st.patchKind || st.boundaryDraw || st.boxDraw) return false;
    st.selectShape(key);
    st.selectPatch(null);
    return true;
  };
  return (
    <Layer listening={junctionsStage || editStage} opacity={designOpacity}>
      {artifacts.junctions.flatMap((j) =>
        j.coverBands.map((b, bi) => (
          <Line
            key={`${j.nodeIds[0]}-cover${bi}`}
            points={b}
            closed
            fill="#525e6a"
            listening={false}
            perfectDrawEnabled={false}
          />
        )),
      )}
      {artifacts.junctions.map((j) => (
        <Line
          key={j.key}
          points={applyShapeOverrides(j.polygon, vertexOverrides[`jring:${j.key}`])}
          closed
          fill="#525e6a"
          stroke={
            junctionsStage
              ? j.key === selectedJunctionKey
                ? '#e08e45'
                : 'rgba(224,142,69,0.55)'
              : 'rgba(30,35,40,0.4)'
          }
          strokeWidth={junctionsStage ? (j.key === selectedJunctionKey ? 2 : 1) : 0.6}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          opacity={dimOthers && j.key !== selectedJunctionKey ? 0.45 : 1}
          {...(junctionsStage
            ? pressable(() => selectJunction(j.key))
            : editStage
              ? pressable((e) => {
                  if (selectShape(`jring:${j.key}`)) e.cancelBubble = true;
                })
              : {})}
          {...(junctionsStage || editStage ? hoverCursor('pointer') : {})}
        />
      ))}
      {artifacts.junctions.flatMap((j) =>
        [...j.wedges, ...j.noses].map((b) => (
          <Line
            key={`${j.nodeIds[0]}-${b.key}`}
            points={applyShapeOverrides(b.polygon, vertexOverrides[`jband:${j.key}:${b.key}`])}
            closed
            fill={KIND_COLORS[b.kind]}
            stroke={showDetail ? 'rgba(30,35,40,0.3)' : undefined}
            strokeWidth={0.5}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            listening={editStage}
            {...(editStage
              ? pressable((e) => {
                  if (selectShape(`jband:${j.key}:${b.key}`)) e.cancelBubble = true;
                })
              : {})}
            {...(editStage ? hoverCursor('pointer') : {})}
          />
        )),
      )}
      {artifacts.junctions
        .filter((j) => j.roundabout)
        .flatMap((j) => {
          const r = j.roundabout!;
          return [
            // circulation guide (mid-circulatory dashed line)
            <Circle
              key={`${j.key}-ring`}
              x={r.cx}
              y={r.cy}
              radius={(r.islandR + r.outerR) / 2}
              stroke="#f2f0e9"
              strokeWidth={1}
              dash={[6, 5]}
              strokeScaleEnabled={false}
              listening={false}
            />,
            // central island
            <Circle
              key={`${j.key}-island`}
              x={r.cx}
              y={r.cy}
              radius={r.islandR}
              fill={KIND_COLORS.median}
              stroke="#f2f0e9"
              strokeWidth={1.2}
              strokeScaleEnabled={false}
              listening={false}
            />,
          ];
        })}
      {artifacts.transitions.flatMap((t) =>
        t.bands.map((b) => (
          <Line
            key={`${t.nodeId}-${b.key}`}
            points={b.polygon}
            closed
            fill={KIND_COLORS[b.kind]}
            stroke={showDetail ? 'rgba(30,35,40,0.35)' : undefined}
            strokeWidth={0.6}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            listening={false}
          />
        )),
      )}
    </Layer>
  );
}
const ArtifactsLayer = memo(ArtifactsLayerImpl);

/** Edit-stage patches: closed material polygons (or ground cuts) with
 *  draggable vertices — the manual escape hatch over the derived design. */
function PatchesLayerImpl({
  patches,
  interactive,
  selectedPatchId,
  scale,
}: {
  patches: Patch[];
  interactive: boolean;
  selectedPatchId: string | null;
  scale: number;
}) {
  const selectPatch = useCst((s) => s.selectPatch);
  const removePatch = useCst((s) => s.removePatch);
  const movePatchVertex = useCst((s) => s.movePatchVertex);
  const removePatchVertex = useCst((s) => s.removePatchVertex);
  const r = 4 / scale;
  return (
    <Layer listening={interactive}>
      {patches.map((p) => (
        <Line
          key={p.id}
          points={p.points}
          closed
          fill={p.kind === 'cut' ? '#f4f2ec' : KIND_COLORS[p.kind]}
          stroke={
            p.id === selectedPatchId
              ? '#e08e45'
              : p.kind === 'cut'
                ? 'rgba(160,70,60,0.55)'
                : 'rgba(30,35,40,0.4)'
          }
          strokeWidth={p.id === selectedPatchId ? 1.6 : 0.8}
          dash={p.kind === 'cut' ? [4, 3] : undefined}
          strokeScaleEnabled={false}
          {...pressable((ev) => {
            if (!interactive) return;
            ev.cancelBubble = true;
            selectPatch(p.id);
          })}
          onContextMenu={(ev) => {
            ev.evt.preventDefault();
            ev.cancelBubble = true;
            removePatch(p.id);
          }}
          {...(interactive ? hoverCursor('pointer') : {})}
        />
      ))}
      {interactive &&
        selectedPatchId &&
        patches
          .filter((p) => p.id === selectedPatchId)
          .flatMap((p) => {
            const out: React.ReactNode[] = [];
            for (let i = 0; i * 2 < p.points.length; i++) {
              out.push(
                <Circle
                  key={`${p.id}-v${i}`}
                  x={p.points[i * 2]}
                  y={p.points[i * 2 + 1]}
                  radius={r}
                  fill="#fff"
                  stroke="#b3541e"
                  strokeWidth={1.5}
                  strokeScaleEnabled={false}
                  draggable
                  {...hoverCursor('move')}
                  onDragStart={() => useCst.temporal.getState().pause()}
                  onDragMove={(ev) => movePatchVertex(p.id, i, ev.target.x(), ev.target.y())}
                  onDragEnd={(ev) => {
                    useCst.temporal.getState().resume();
                    movePatchVertex(p.id, i, ev.target.x(), ev.target.y());
                  }}
                  onContextMenu={(ev) => {
                    ev.evt.preventDefault();
                    ev.cancelBubble = true;
                    removePatchVertex(p.id, i);
                  }}
                />,
              );
            }
            return out;
          })}
    </Layer>
  );
}
const PatchesLayer = memo(PatchesLayerImpl);

/** Traced land-ownership / ROW boundaries: dashed plot lines rendered in every
 *  stage, editable (select, drag vertices, right-click) in the network stage. */
function BoundariesLayerImpl({
  boundaries,
  interactive,
  selectedBoundaryId,
  scale,
}: {
  boundaries: Boundary[];
  interactive: boolean;
  selectedBoundaryId: string | null;
  scale: number;
}) {
  const selectBoundary = useCst((s) => s.selectBoundary);
  const removeBoundary = useCst((s) => s.removeBoundary);
  const moveBoundaryVertex = useCst((s) => s.moveBoundaryVertex);
  const removeBoundaryVertex = useCst((s) => s.removeBoundaryVertex);
  const r = 4 / scale;
  return (
    <Layer listening={interactive}>
      {boundaries.map((b) => (
        <Line
          key={b.id}
          points={b.points}
          stroke={b.id === selectedBoundaryId ? '#e08e45' : '#8a5a2b'}
          strokeWidth={b.id === selectedBoundaryId ? 2.2 : 1.6}
          dash={[9, 4, 2, 4]}
          strokeScaleEnabled={false}
          hitStrokeWidth={12}
          {...pressable((ev) => {
            const t = useCst.getState().tool;
            if (!interactive) return;
            ev.cancelBubble = true;
            if (t === 'erase') removeBoundary(b.id);
            else selectBoundary(b.id);
          })}
          onContextMenu={(ev) => {
            ev.evt.preventDefault();
            ev.cancelBubble = true;
            removeBoundary(b.id);
          }}
          {...(interactive ? hoverCursor('pointer') : {})}
        />
      ))}
      {interactive &&
        selectedBoundaryId &&
        boundaries
          .filter((b) => b.id === selectedBoundaryId)
          .flatMap((b) => {
            const out: React.ReactNode[] = [];
            for (let i = 0; i * 2 < b.points.length; i++) {
              out.push(
                <Circle
                  key={`${b.id}-v${i}`}
                  x={b.points[i * 2]}
                  y={b.points[i * 2 + 1]}
                  radius={r}
                  fill="#fff"
                  stroke="#8a5a2b"
                  strokeWidth={1.5}
                  strokeScaleEnabled={false}
                  draggable
                  {...hoverCursor('move')}
                  onDragStart={() => useCst.temporal.getState().pause()}
                  onDragMove={(ev) => moveBoundaryVertex(b.id, i, ev.target.x(), ev.target.y())}
                  onDragEnd={(ev) => {
                    useCst.temporal.getState().resume();
                    moveBoundaryVertex(b.id, i, ev.target.x(), ev.target.y());
                  }}
                  onContextMenu={(ev) => {
                    ev.evt.preventDefault();
                    ev.cancelBubble = true;
                    removeBoundaryVertex(b.id, i);
                  }}
                />,
              );
            }
            return out;
          })}
    </Layer>
  );
}
const BoundariesLayer = memo(BoundariesLayerImpl);

/** CAD vertex editing (Edit stage): every vertex of the selected generated
 *  shape becomes a handle. With welded-mesh editing on, coincident vertices
 *  of ABUTTING shapes (footpath edge = carriageway edge, band mouth =
 *  junction cap) form shared nodes — dragging one moves every member, so
 *  adjacent sub-polygons reshape together and never tear. Drags store
 *  parametric (along, across) deltas per member shape — geometry stays
 *  derived. Right-click a node resets it (all members). */
function ShapeEditLayer({
  shapeKey,
  base,
  weldMap,
  scale,
}: {
  shapeKey: string;
  base: number[];
  weldMap: MeshMember[][];
  scale: number;
}) {
  const vertexOverrides = useCst((s) => s.vertexOverrides);
  const meshEdit = useCst((s) => s.meshEdit);
  const setVertexDeltas = useCst((s) => s.setVertexDeltas);
  const removeVertexDeltas = useCst((s) => s.removeVertexDeltas);
  const display = applyShapeOverrides(base, vertexOverrides[shapeKey]);
  const r = 4 / scale;
  const n = display.length / 2;
  const dragTo = (i: number, wx: number, wy: number) => {
    // Snap to traced plot boundaries — the whole point of tracing them first
    // is adjusting footpath edges onto the real land line.
    const st = useCst.getState();
    if (st.layers.boundaries) {
      const tol = 10 / scale;
      for (const b of Object.values(st.boundaries)) {
        const proj = projectOnPolyline(b.points, wx, wy);
        if (proj && proj.dist < tol) {
          wx = proj.x;
          wy = proj.y;
          break;
        }
      }
    }
    const entries = weldedDragDeltas(
      shapeKey,
      base,
      st.meshEdit ? weldMap : [],
      st.vertexOverrides,
      i,
      wx,
      wy,
    );
    setVertexDeltas(entries);
  };
  return (
    <Layer>
      <Line
        points={display}
        closed
        stroke="#e08e45"
        strokeWidth={1.6}
        dash={[5, 3]}
        strokeScaleEnabled={false}
        listening={false}
      />
      {Array.from({ length: n }, (_, i) => {
        const welded = meshEdit && (weldMap[i]?.length ?? 0) > 0;
        return (
          <Circle
            key={i}
            x={display[i * 2]}
            y={display[i * 2 + 1]}
            radius={welded ? r * 1.15 : r}
            // green = shared mesh node (moves every abutting shape)
            fill={welded ? '#dff2e4' : '#fff'}
            stroke={welded ? '#0a8f4b' : '#b3541e'}
            strokeWidth={1.5}
            strokeScaleEnabled={false}
            draggable
            {...hoverCursor('move')}
            onDragStart={() => useCst.temporal.getState().pause()}
            onDragMove={(ev) => dragTo(i, ev.target.x(), ev.target.y())}
            onDragEnd={(ev) => {
              useCst.temporal.getState().resume();
              dragTo(i, ev.target.x(), ev.target.y());
            }}
            onContextMenu={(ev) => {
              ev.evt.preventDefault();
              ev.cancelBubble = true;
              // reset this node on the target AND every welded member
              const st = useCst.getState();
              const entries = weldedDragDeltas(
                shapeKey,
                base,
                st.meshEdit ? weldMap : [],
                st.vertexOverrides,
                i,
                base[i * 2],
                base[i * 2 + 1],
              ).map(({ shapeKey: sk, key }) => ({ shapeKey: sk, key }));
              removeVertexDeltas(entries);
            }}
          />
        );
      })}
    </Layer>
  );
}

const TURN_COLORS: Record<string, string> = {
  through: '#4a90d9',
  left: '#4CAF50',
  right: '#e08e45',
  uturn: '#999999',
};

/** Focused-junction editing layer (J3+J4): movement arrows, draggable corner
 *  radius dots and approach trim squares. Everything edits parameters with
 *  stable keys — geometry regenerates live. */
function JunctionHandlesLayer({ j, scale }: { j: JunctionPoly; scale: number }) {
  const setCornerRadius = useCst((s) => s.setCornerRadius);
  const toggleCornerChamfer = useCst((s) => s.toggleCornerChamfer);
  const setApproachTrim = useCst((s) => s.setApproachTrim);
  const r = 6 / scale;

  return (
    <Layer>
      {j.movements.map((m) => (
        <Arrow
          key={`${m.from}>${m.to}`}
          points={m.pts}
          stroke={TURN_COLORS[m.turn]}
          fill={TURN_COLORS[m.turn]}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          pointerLength={7 / scale}
          pointerWidth={5 / scale}
          opacity={0.8}
          listening={false}
        />
      ))}
      {j.corners.map((c) => (
        <Circle
          key={c.key}
          x={c.x}
          y={c.y}
          radius={r}
          fill={c.overridden ? '#e08e45' : '#fff'}
          stroke="#b3541e"
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          draggable
          {...hoverCursor('grab')}
          onDragStart={(ev) => {
            if (!useCst.getState().guardMeshEdit()) {
              ev.target.stopDrag();
              ev.target.position({ x: c.x, y: c.y });
              return;
            }
            useCst.temporal.getState().pause();
            (ev.target as Konva.Shape).setAttr('dragFrom', { x: c.x, y: c.y, r: c.radiusM ?? 4 });
          }}
          onDragMove={(ev) => {
            const from = (ev.target as Konva.Shape).getAttr('dragFrom') as { x: number; y: number; r: number };
            const d = (ev.target.x() - from.x) * c.bx + (ev.target.y() - from.y) * c.by;
            const radius = Math.min(30, Math.max(MIN_JUNCTION_R, Math.round((from.r + d) * 2) / 2));
            setCornerRadius(j.key, c.key, radius);
          }}
          onDragEnd={(ev) => {
            useCst.temporal.getState().resume();
            // snap the handle back onto the regenerated arc midpoint
            ev.target.position({ x: c.x, y: c.y });
          }}
          onContextMenu={(ev) => {
            ev.evt.preventDefault();
            ev.cancelBubble = true;
            if (ev.evt.shiftKey) setCornerRadius(j.key, c.key, null);
            else toggleCornerChamfer(j.key, c.key);
          }}
        />
      ))}
      {j.approachInfos.map((a) => (
        <Rect
          key={a.key}
          x={a.x - r * 0.9}
          y={a.y - r * 0.9}
          width={r * 1.8}
          height={r * 1.8}
          fill={a.overridden ? '#e08e45' : '#fff'}
          stroke="#b3541e"
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          draggable
          {...hoverCursor('grab')}
          onDragStart={(ev) => {
            if (!useCst.getState().guardMeshEdit()) {
              ev.target.stopDrag();
              ev.target.position({ x: a.x - r * 0.9, y: a.y - r * 0.9 });
              return;
            }
            useCst.temporal.getState().pause();
            (ev.target as Konva.Shape).setAttr('dragFrom', { x: ev.target.x(), y: ev.target.y(), trim: a.trim });
          }}
          onDragMove={(ev) => {
            const from = (ev.target as Konva.Shape).getAttr('dragFrom') as { x: number; y: number; trim: number };
            const d = (ev.target.x() - from.x) * a.dx + (ev.target.y() - from.y) * a.dy;
            const trim = Math.min(a.maxTrim, Math.max(0.5, Math.round((from.trim + d) * 2) / 2));
            setApproachTrim(j.key, a.key, trim);
          }}
          onDragEnd={(ev) => {
            useCst.temporal.getState().resume();
            ev.target.position({ x: a.x - r * 0.9, y: a.y - r * 0.9 });
          }}
          onContextMenu={(ev) => {
            ev.evt.preventDefault();
            ev.cancelBubble = true;
            setApproachTrim(j.key, a.key, null);
          }}
        />
      ))}
    </Layer>
  );
}

const MIN_JUNCTION_R = 1;

/** Fill colour for a mesh face: component palette + the two mesh-only fns. */
function meshFill(fn: MeshFace['fn']): string {
  if (fn === 'junction') return '#525e6a';
  if (fn === 'island') return KIND_COLORS.median;
  return KIND_COLORS[fn];
}

/** Trace a face outline drawing TRUE circular arcs through arc-mid nodes
 *  (three-point arcs — the mesh stores curves as start/mid/end, not samples). */
function traceFace(ctx: Konva.Context, mesh: Mesh, f: MeshFace): boolean {
  const ids = f.nodes.filter((id) => mesh.nodes[id]);
  const n = ids.length;
  if (n < 3) return false;
  const r0 = Math.max(ids.findIndex((id) => !mesh.nodes[id].arc), 0);
  const P = (i: number) => mesh.nodes[ids[(i + r0) % n]];
  ctx.beginPath();
  ctx.moveTo(P(0).x, P(0).y);
  let i = 1;
  while (i <= n) {
    const m = P(i % n);
    if (m.arc && i < n) {
      const A = P(i - 1);
      const B = P(i + 1);
      const c = circleFrom3(A.x, A.y, m.x, m.y, B.x, B.y);
      if (c) {
        const TAU = 2 * Math.PI;
        const a0 = Math.atan2(A.y - c.y, A.x - c.x);
        const d1 = (((Math.atan2(B.y - c.y, B.x - c.x) - a0) % TAU) + TAU) % TAU;
        const dm = (((Math.atan2(m.y - c.y, m.x - c.x) - a0) % TAU) + TAU) % TAU;
        ctx.arc(c.x, c.y, c.r, a0, a0 + (dm <= d1 ? d1 : d1 - TAU), dm > d1);
      } else {
        ctx.lineTo(m.x, m.y);
        ctx.lineTo(B.x, B.y);
      }
      i += 2;
    } else {
      ctx.lineTo(m.x, m.y);
      i++;
    }
  }
  ctx.closePath();
  return true;
}

/** The frozen node-mesh (Mesh stage): every face is a closed polygon over
 *  SHARED node ids — dragging one node reshapes every abutting face live
 *  (spec §6.2 no-cracks). Clicks route through the active mesh tool; node
 *  drags pause undo history and weld onto a coincident node on drop. */
function MeshLayerImpl({
  mesh,
  interactive,
  selectedFaceId,
  meshPick,
  meshTool,
  scale,
  viewRect,
}: {
  mesh: Mesh;
  interactive: boolean;
  selectedFaceId: string | null;
  meshPick: string | null;
  meshTool: string;
  scale: number;
  viewRect: { minX: number; minY: number; maxX: number; maxY: number } | null;
}) {
  // Node handles: only in select (drag), addnode/split/fillet (click) modes,
  // culled to the viewport and hidden when zoomed far out (they'd be soup).
  const wantNodes = interactive && ['select', 'split', 'fillet'].includes(meshTool);
  const nodeIds = useMemo(() => {
    if (!wantNodes) return [];
    const ids = Object.keys(mesh.nodes);
    const vis =
      !viewRect || ids.length <= 300
        ? ids
        : ids.filter((id) => {
            const p = mesh.nodes[id];
            return p.x >= viewRect.minX && p.x <= viewRect.maxX && p.y >= viewRect.minY && p.y <= viewRect.maxY;
          });
    // handle soup: zoomed out over thousands of nodes, draw none (count-based,
    // not scale-based — a hard zoom threshold made handles pop in and out)
    return vis.length > 1500 ? [] : vis;
  }, [wantNodes, mesh.nodes, viewRect]);

  const onFacePress = (f: MeshFace) => (e: KonvaEventObject<MouseEvent>) => {
    if (!interactive) return;
    e.cancelBubble = true;
    const st = useCst.getState();
    const w = stageToWorld(e.target.getStage()!);
    switch (st.meshTool) {
      case 'delete':
        st.meshDeleteFace(f.id);
        return;
      case 'merge':
        st.meshMergePick(f.id);
        return;
      case 'cut': {
        if (f.kind !== 'strip' || !f.edge || !w) {
          st.selectFace(f.id);
          return;
        }
        // t along the street axis: project the click on the a-row→b-row side
        const a = mesh.nodes[f.nodes[0]];
        const b = mesh.nodes[f.nodes[f.nodes.length - 1]];
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = len2 < 1e-9 ? 0.5 : ((w.x - a.x) * (b.x - a.x) + (w.y - a.y) * (b.y - a.y)) / len2;
        st.meshCut(f.edge, parseInt(f.id.split(':')[2], 10), Math.min(0.9, Math.max(0.1, t)));
        return;
      }
      case 'addnode': {
        if (!w) return;
        // nearest boundary segment of the clicked face
        let best: { a: string; b: string; x: number; y: number; d: number } | null = null;
        for (let i = 0; i < f.nodes.length; i++) {
          const na = f.nodes[i];
          const nb = f.nodes[(i + 1) % f.nodes.length];
          const A = mesh.nodes[na];
          const B = mesh.nodes[nb];
          const len2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
          if (len2 < 1e-9) continue;
          const u = Math.min(0.92, Math.max(0.08,
            ((w.x - A.x) * (B.x - A.x) + (w.y - A.y) * (B.y - A.y)) / len2));
          const px = A.x + (B.x - A.x) * u;
          const py = A.y + (B.y - A.y) * u;
          const d = dist(w.x, w.y, px, py);
          if (!best || d < best.d) best = { a: na, b: nb, x: px, y: py, d };
        }
        if (best) st.meshInsertNode(best.a, best.b, best.x, best.y);
        return;
      }
      default:
        st.selectFace(f.id);
    }
  };

  return (
    <Layer listening={interactive}>
      {mesh.faces.map((f) => {
        if (f.nodes.filter((nid) => mesh.nodes[nid]).length < 3) return null;
        const selected = f.id === selectedFaceId;
        const picked = f.id === meshPick;
        return (
          <Shape
            key={f.id}
            sceneFunc={(ctx, shape) => {
              if (traceFace(ctx, mesh, f)) ctx.fillStrokeShape(shape);
            }}
            fill={meshFill(f.fn)}
            stroke={selected ? '#d97a2e' : picked ? '#0a8f4b' : 'rgba(20,24,29,0.45)'}
            strokeWidth={selected || picked ? 2.2 : 0.8}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            {...(interactive ? pressable(onFacePress(f)) : {})}
            {...(interactive ? hoverCursor('pointer') : {})}
          />
        );
      })}
      {nodeIds.map((nid) => {
        const p = mesh.nodes[nid];
        const pickedN = nid === meshPick;
        return (
          <Circle
            key={nid}
            x={p.x}
            y={p.y}
            radius={Math.max(3.2 / scale, 0.12)}
            fill={pickedN ? '#0a8f4b' : '#ffffff'}
            stroke="#14181d"
            strokeWidth={1}
            strokeScaleEnabled={false}
            perfectDrawEnabled={false}
            draggable={meshTool === 'select'}
            {...hoverCursor(meshTool === 'select' ? 'move' : 'pointer')}
            {...pressable((e) => {
              const st = useCst.getState();
              if (st.meshTool === 'split') {
                e.cancelBubble = true;
                st.meshSplitPick(nid);
              } else if (st.meshTool === 'fillet') {
                e.cancelBubble = true;
                st.meshFillet(nid);
              }
            })}
            onDragStart={() => useCst.temporal.getState().pause()}
            onDragMove={(e) => useCst.getState().meshMoveNode(nid, e.target.x(), e.target.y(), true)}
            onDragEnd={(e) => {
              useCst.temporal.getState().resume();
              const x = e.target.x();
              const y = e.target.y();
              const st = useCst.getState();
              st.meshMoveNode(nid, x, y);
              // drop onto a coincident node → weld (sliver faces collapse)
              const tol = 8 / scale;
              const m = st.mesh;
              if (!m) return;
              let hit: string | null = null;
              let hd = tol;
              for (const [oid, q] of Object.entries(m.nodes)) {
                if (oid === nid) continue;
                const d = dist(q.x, q.y, x, y);
                if (d < hd) {
                  hd = d;
                  hit = oid;
                }
              }
              if (hit) st.meshWeld(nid, hit);
            }}
          />
        );
      })}
    </Layer>
  );
}
const MeshLayer = memo(MeshLayerImpl);

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 5 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  // marquee/lasso region being dragged, world coords (marquee: [x0,y0,x1,y1])
  const [region, setRegion] = useState<number[] | null>(null);
  const regionRef = useRef<number[] | null>(null);
  const centeredRef = useRef(false);
  const coordsRef = useRef<HTMLDivElement>(null);
  const pendingViewRef = useRef<{ x: number; y: number } | null>(null);
  const viewRafRef = useRef<number | null>(null);
  // two-finger pinch state (distance + midpoint of the previous frame)
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const stage = useCst((s) => s.stage);
  const tool = useCst((s) => s.tool);
  const origin = useCst((s) => s.origin);
  const basemap = useCst((s) => s.basemap);
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const selectedEdgeIds = useCst((s) => s.selectedEdgeIds);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const selectedJunctionKey = useCst((s) => s.selectedJunctionKey);
  const selectJunction = useCst((s) => s.selectJunction);
  const elements = useCst((s) => s.elements);
  const placeKind = useCst((s) => s.placeKind);
  const selectedElementId = useCst((s) => s.selectedElementId);
  const patches = useCst((s) => s.patches);
  const selectedShapeKey = useCst((s) => s.selectedShapeKey);
  const boundaries = useCst((s) => s.boundaries);
  const boundaryDraw = useCst((s) => s.boundaryDraw);
  const boundaryDraft = useCst((s) => s.boundaryDraft);
  const selectedBoundaryId = useCst((s) => s.selectedBoundaryId);
  const boxDraw = useCst((s) => s.boxDraw);
  const importBox = useCst((s) => s.importBox);
  const exportBounds = useCst((s) => s.exportBounds);
  const patchKind = useCst((s) => s.patchKind);
  const patchDraft = useCst((s) => s.patchDraft);
  const selectedPatchId = useCst((s) => s.selectedPatchId);
  const designOpacity = useCst((s) => s.designOpacity);
  const highlightEdges = useCst((s) => s.highlightEdges);
  const draft = useCst((s) => s.draft);
  const pendingFit = useCst((s) => s.pendingFit);
  const settings = useCst((s) => s.settings);
  const layers = useCst((s) => s.layers);
  const addDraftVert = useCst((s) => s.addDraftVert);
  const finishDraft = useCst((s) => s.finishDraft);
  const mesh = useCst((s) => s.mesh);
  const meshTool = useCst((s) => s.meshTool);
  const selectedFaceId = useCst((s) => s.selectedFaceId);
  const meshPick = useCst((s) => s.meshPick);
  // Once frozen, the mesh IS the surface geometry from its stage onward —
  // generated bands/junctions hide so edits aren't drawn over by stale shapes.
  const meshActive =
    !!mesh && (stage === 'mesh' || stage === 'detailing' || stage === 'edit' || stage === 'export');

  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const nodeList = useMemo(() => Object.values(nodes), [nodes]);
  const elementList = useMemo(() => Object.values(elements), [elements]);
  const patchList = useMemo(() => Object.values(patches), [patches]);

  // ── Viewport culling + LOD (perf: only mount what the view can show) ──
  const showDetail = !settings.lod || view.scale >= DETAIL_SCALE;
  // Quantize the camera for culling: the cull rect only changes on
  // quarter-viewport pan steps / half-octave zoom steps, so the culled arrays
  // keep their identity while panning — otherwise every drag frame would
  // reconcile every Konva node. The pad covers the quantization slack.
  const qs = Math.pow(2, Math.floor(Math.log2(view.scale) * 2) / 2); // ≤ scale → superset size
  // Quantize the WORLD-space top-left (not the screen offset): converting a
  // screen-quantized offset with qs ≠ scale shifts the rect by a fraction of
  // the distance to the world origin — shapes visibly vanished mid-octave.
  const qStep = (Math.max(size.width, size.height) / qs) * 0.25 || 1;
  const qx = Math.round(-view.x / view.scale / qStep) * qStep;
  const qy = Math.round(-view.y / view.scale / qStep) * qStep;
  const viewRect = useMemo(() => {
    if (size.width === 0) return null;
    const w = size.width / qs;
    const h = size.height / qs;
    const pad = Math.max(w, h) * CULL_PAD; // covers the ≤ qStep/2 quantization slack
    return { minX: qx - pad, minY: qy - pad, maxX: qx + w + pad, maxY: qy + h + pad };
  }, [qx, qy, qs, size]);
  const visibleEdges = useMemo(() => {
    if (!viewRect || edgeList.length <= CULL_MIN_EDGES) return edgeList;
    return edgesInRect(
      { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
      viewRect.minX,
      viewRect.minY,
      viewRect.maxX,
      viewRect.maxY,
    );
  }, [viewRect, edgeList, nodes, edges]);
  const visibleElements = useMemo(() => {
    if (visibleEdges === edgeList) return elementList;
    const ids = new Set(visibleEdges.map((e) => e.id));
    return elementList.filter((el) => ids.has(el.edgeId));
  }, [visibleEdges, edgeList, elementList]);
  const visibleNodes = useMemo(() => {
    if (stage !== 'network' || !viewRect || nodeList.length <= CULL_MIN_EDGES) return nodeList;
    return nodeList.filter(
      (n) => n.x >= viewRect.minX && n.x <= viewRect.maxX && n.y >= viewRect.minY && n.y <= viewRect.maxY,
    );
  }, [stage, viewRect, nodeList]);
  const boundaryList = useMemo(() => Object.values(boundaries), [boundaries]);
  // Only the network stage renders nodes — don't pay O(nodes × edges) elsewhere.
  const degrees = useMemo(() => {
    const d: Record<string, number> = {};
    if (stage !== 'network') return d;
    const g = { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 };
    for (const n of nodeList) d[n.id] = degree(g, n.id);
    return d;
  }, [nodes, edges, nodeList, stage]);

  // Derived node artifacts (§1.2): junction polygons, node transitions, trims.
  const showSections = stage !== 'network';
  const artifacts = useMemo(
    () =>
      showSections
        ? deriveNodeArtifactsCached(
            { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 },
            junctionDesigns,
            settings.junctionCorners,
          )
        : { junctions: [], transitions: [], trims: {} },
    [nodes, edges, showSections, junctionDesigns, settings.junctionCorners],
  );
  const focusedJunction =
    stage === 'junctions' && selectedJunctionKey
      ? artifacts.junctions.find((j) => j.key === selectedJunctionKey) ?? null
      : null;

  // Culled artifact view for rendering (derivation itself is uncut — trims
  // must stay complete for ribbon geometry).
  const visibleArtifacts = useMemo(() => {
    if (!viewRect || artifacts.junctions.length <= 40) return artifacts;
    const inRect = (x: number, y: number) =>
      x >= viewRect.minX && x <= viewRect.maxX && y >= viewRect.minY && y <= viewRect.maxY;
    return {
      junctions: artifacts.junctions.filter((j) => inRect(j.polygon[0], j.polygon[1])),
      transitions: artifacts.transitions.filter(
        (t) => t.bands[0] && inRect(t.bands[0].polygon[0], t.bands[0].polygon[1]),
      ),
      trims: artifacts.trims,
    };
  }, [artifacts, viewRect]);

  // Base (pre-override) outline of the generated shape being vertex-edited.
  const selectedShapeBase = useMemo(() => {
    if (stage !== 'edit' || !selectedShapeKey) return null;
    if (selectedShapeKey.startsWith('band:')) {
      const [, edgeId, ...rest] = selectedShapeKey.split(':');
      const e = edges[edgeId];
      if (!e?.section) return null;
      const bandKey = rest.join(':');
      const { bands } = buildEdgeGeometry(e, artifacts.trims[edgeId]);
      return bands.find((b) => b.key === bandKey)?.polygon ?? null;
    }
    if (selectedShapeKey.startsWith('jring:')) {
      const jKey = selectedShapeKey.slice('jring:'.length);
      return artifacts.junctions.find((j) => j.key === jKey)?.polygon ?? null;
    }
    if (selectedShapeKey.startsWith('jband:')) {
      const [, jKey, ...rest] = selectedShapeKey.split(':');
      const bandKey = rest.join(':');
      const j = artifacts.junctions.find((x) => x.key === jKey);
      if (!j) return null;
      return [...j.wedges, ...j.noses].find((b) => b.key === bandKey)?.polygon ?? null;
    }
    return null;
  }, [stage, selectedShapeKey, edges, artifacts]);

  // Welded mesh for the shape being edited: which vertices of abutting
  // generated shapes coincide with each of its vertices (Mesh_Architecture.md).
  const selectedShapeWeld = useMemo(() => {
    if (stage !== 'edit' || !selectedShapeKey || !selectedShapeBase) return [];
    return weldMapFor({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }, artifacts, selectedShapeKey);
  }, [stage, selectedShapeKey, selectedShapeBase, nodes, edges, artifacts]);


  useEffect(() => {
    const el = containerRef.current!;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Put the world origin at the canvas center once we know our size.
  useEffect(() => {
    if (!centeredRef.current && size.width > 0) {
      centeredRef.current = true;
      setView((v) => ({ ...v, x: size.width / 2, y: size.height / 2 }));
    }
  }, [size]);

  // Fit view to freshly imported data.
  useEffect(() => {
    if (!pendingFit || size.width === 0) return;
    const { minX, minY, maxX, maxY } = pendingFit;
    const w = Math.max(maxX - minX, 10);
    const h = Math.max(maxY - minY, 10);
    const scale = Math.min(MAX_SCALE, Math.min((size.width * 0.9) / w, (size.height * 0.9) / h));
    setView({
      scale,
      x: size.width / 2 - ((minX + maxX) / 2) * scale,
      y: size.height / 2 - ((minY + maxY) / 2) * scale,
    });
    useCst.setState({ pendingFit: null });
  }, [pendingFit, size]);

  const toWorld = stageToWorld;

  /** Two-finger pinch: zoom about the finger midpoint, pan with its drift.
   *  One-finger pan rides the stage's normal (touch-driven) drag. */
  const onTouchMove = (e: KonvaEventObject<TouchEvent>) => {
    const [t1, t2] = [e.evt.touches[0], e.evt.touches[1]];
    if (!t1 || !t2) return;
    e.evt.preventDefault();
    const stageNode = e.target.getStage()!;
    if (stageNode.isDragging()) stageNode.stopDrag(); // pinch overrides pan-drag
    const rect = stageNode.container().getBoundingClientRect();
    const p1 = { x: t1.clientX - rect.left, y: t1.clientY - rect.top };
    const p2 = { x: t2.clientX - rect.left, y: t2.clientY - rect.top };
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    const d = Math.max(Math.hypot(p2.x - p1.x, p2.y - p1.y), 1);
    const prev = pinchRef.current;
    pinchRef.current = { dist: d, cx, cy };
    if (!prev) return;
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * (d / prev.dist)));
      const applied = scale / v.scale;
      return {
        scale,
        x: cx - (prev.cx - v.x) * applied,
        y: cy - (prev.cy - v.y) * applied,
      };
    });
  };

  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stageNode = e.target.getStage()!;
    const pos = stageNode.getPointerPosition();
    if (!pos) return;
    const factor = e.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const world = stageToWorld(stageNode);
    if (!world) return;
    setView({ scale, x: pos.x - world.x * scale, y: pos.y - world.y * scale });
  };

  /** Apply Shift 15°-increment constraint relative to the previous draft vertex. */
  const constrain = (w: { x: number; y: number }, shift: boolean) => {
    if (!shift || draft.length === 0) return w;
    const prev = draft[draft.length - 1];
    const dx = w.x - prev.x;
    const dy = w.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return w;
    const step = Math.PI / 12; // 15°
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: prev.x + len * Math.cos(ang), y: prev.y + len * Math.sin(ang) };
  };

  /** Edge sample points (vertices + subdivided long segments) for region tests. */
  const edgeSamples = (e: StreetEdge): number[] => {
    const out: number[] = [];
    const p = e.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const segLen = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const n = Math.max(1, Math.ceil(segLen / 8));
      for (let k = 0; k < n; k++) {
        out.push(p[i] + ((p[i + 2] - p[i]) * k) / n, p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / n);
      }
    }
    out.push(p[p.length - 2], p[p.length - 1]);
    return out;
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    // Middle-drag pans in ANY mode — lets you keep drawing across the screen
    // edge without dropping the draft.
    if (e.evt.button === 1) {
      e.evt.preventDefault(); // no browser autoscroll
      const startX = e.evt.clientX;
      const startY = e.evt.clientY;
      const v0 = { x: view.x, y: view.y };
      const move = (me: MouseEvent) => {
        pendingViewRef.current = { x: v0.x + me.clientX - startX, y: v0.y + me.clientY - startY };
        if (viewRafRef.current === null) {
          viewRafRef.current = requestAnimationFrame(() => {
            viewRafRef.current = null;
            const p = pendingViewRef.current;
            if (p) setView((v) => ({ ...v, x: p.x, y: p.y }));
          });
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    if (e.evt.button !== 0) return;
    if (boxDraw) {
      const w = toWorld(e.target.getStage()!);
      if (!w) return;
      const start = [w.x, w.y, w.x, w.y];
      regionRef.current = start;
      setRegion(start);
      return;
    }
    if (tool !== 'marquee' && tool !== 'lasso') return;
    const w = toWorld(e.target.getStage()!);
    if (!w) return;
    const start = tool === 'marquee' ? [w.x, w.y, w.x, w.y] : [w.x, w.y];
    regionRef.current = start;
    setRegion(start);
  };

  const onMouseUp = (e: KonvaEventObject<MouseEvent>) => {
    const r = regionRef.current;
    if (!r) return;
    regionRef.current = null;
    setRegion(null);
    if (boxDraw && r.length === 4) {
      const b = {
        minX: Math.min(r[0], r[2]),
        minY: Math.min(r[1], r[3]),
        maxX: Math.max(r[0], r[2]),
        maxY: Math.max(r[1], r[3]),
      };
      if ((b.maxX - b.minX) * view.scale > 8 && (b.maxY - b.minY) * view.scale > 8) {
        useCst.getState().setBox(boxDraw, b);
      } else {
        useCst.getState().setBoxDraw(null);
      }
      return;
    }
    const mode = e.evt.shiftKey ? 'add' : e.evt.ctrlKey || e.evt.metaKey ? 'toggle' : 'replace';
    let hit: string[] = [];
    if (tool === 'marquee' && r.length === 4) {
      const [x0, x1] = [Math.min(r[0], r[2]), Math.max(r[0], r[2])];
      const [y0, y1] = [Math.min(r[1], r[3]), Math.max(r[1], r[3])];
      if ((x1 - x0) * view.scale < 4 && (y1 - y0) * view.scale < 4) return; // a click, not a drag
      hit = edgeList
        .filter((ed) => edgeSamples(ed).some((_, i, a) => i % 2 === 0 && a[i] >= x0 && a[i] <= x1 && a[i + 1] >= y0 && a[i + 1] <= y1))
        .map((ed) => ed.id);
    } else if (tool === 'lasso' && r.length >= 6) {
      hit = edgeList
        .filter((ed) => {
          const s = edgeSamples(ed);
          for (let i = 0; i + 1 < s.length; i += 2) {
            if (pointInPolygon(s[i], s[i + 1], r)) return true;
          }
          return false;
        })
        .map((ed) => ed.id);
    } else return;
    useCst.getState().selectEdges(hit, mode);
  };

  const onClick = (e: KonvaEventObject<MouseEvent>) => {
    const stageNode = e.target.getStage()!;
    // Box-draw owns the gesture end-to-end (mousedown/move/up); a click that
    // completes or cancels a box must not also run a tool/place action.
    if (boxDraw) return;
    if (boundaryDraw) {
      const w = toWorld(stageNode);
      if (w) useCst.getState().addBoundaryVert(w.x, w.y);
      return;
    }
    if (tool === 'draw') {
      const w = toWorld(stageNode);
      if (!w) return;
      const c = constrain(w, e.evt.shiftKey);
      // Compute the snap HERE, not from state: the mousemove preceding a fast
      // click may not have re-rendered yet, and a stale snap would duplicate
      // the previous vertex (which the stationary-dblclick check then eats).
      const s = findSnap(c.x, c.y, SNAP_PX / view.scale, nodes, edges);
      addDraftVert(s ? { x: s.x, y: s.y, snap: s } : { x: c.x, y: c.y, snap: null });
    } else if (stage === 'edit' && patchKind) {
      const w = toWorld(stageNode);
      if (w) useCst.getState().addPatchVert(w.x, w.y);
    } else if (stage === 'detailing' && placeKind) {
      const w = toWorld(stageNode);
      if (w) useCst.getState().placeElementAt(w.x, w.y, 40 / view.scale);
    } else if (tool === 'select' && e.target === stageNode) {
      if (stage === 'detailing') useCst.getState().selectElement(null);
      else if (stage === 'edit') {
        useCst.getState().selectPatch(null);
        useCst.getState().selectShape(null);
      } else if (stage === 'junctions') selectJunction(null);
      else if (stage === 'mesh') useCst.getState().selectFace(null);
      else useCst.getState().selectEdge(null);
    }
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const w = toWorld(e.target.getStage()!);
    if (!w) return;
    const r = regionRef.current;
    if (r) {
      if (boxDraw || tool === 'marquee') {
        const next = [r[0], r[1], w.x, w.y];
        regionRef.current = next;
        setRegion(next);
      } else if (tool === 'lasso') {
        const lx = r[r.length - 2], ly = r[r.length - 1];
        if (Math.hypot(w.x - lx, w.y - ly) * view.scale > 3) {
          const next = [...r, w.x, w.y];
          regionRef.current = next;
          setRegion(next);
        }
      }
    }
    const c = constrain(w, e.evt.shiftKey);
    // The coords pill updates imperatively — a React state set per mousemove
    // would re-render the whole canvas component at pointer frequency.
    if (coordsRef.current) coordsRef.current.textContent = `${c.x.toFixed(1)}, ${c.y.toFixed(1)} m`;
    // Cursor STATE only feeds the live drawing previews — keep React out of
    // the loop whenever no preview is on screen.
    if (tool === 'draw' || boundaryDraw || (stage === 'edit' && patchKind)) setCursor(c);
    else if (cursor) setCursor(null);
    if (tool === 'draw') {
      setSnap(findSnap(c.x, c.y, SNAP_PX / view.scale, nodes, edges));
    } else if (snap) {
      setSnap(null);
    }
  };

  // Konva synthesizes dblclick from ANY two clicks within its time window, even far
  // apart — rapid vertex clicking must not finish the street. Only finish when the
  // double-click is stationary: the last two draft points (click fires before
  // dblclick, so the duplicate is already in the draft) nearly coincide on screen.
  const onDblClick = () => {
    if (boundaryDraw) {
      // Same stationary-dblclick rule as street drawing: Konva synthesizes
      // dblclick from ANY two clicks in its window, so only finish when the
      // last two clicks landed on (nearly) the same spot.
      const st = useCst.getState();
      const d = st.boundaryDraft;
      if (
        d.length >= 6 &&
        dist(d[d.length - 4], d[d.length - 3], d[d.length - 2], d[d.length - 1]) * view.scale < 6
      ) {
        st.finishBoundary();
      }
      return;
    }
    if (stage === 'edit') {
      const st = useCst.getState();
      if (st.patchDraft.length >= 6) st.finishPatch();
      return;
    }
    if (tool !== 'draw') return;
    const d = useCst.getState().draft;
    if (d.length < 2) return;
    const a = d[d.length - 2];
    const b = d[d.length - 1];
    if (dist(a.x, a.y, b.x, b.y) * view.scale < 6) finishDraft(0.5);
  };

  const TOOL_HINTS: Partial<Record<Tool, string>> = {
    draw: 'Click to add points (snaps to nodes/edges · Shift = 15° angles) · double-click or Enter to finish · Esc to cancel',
    split: 'Click a street to insert a node (a node between different sections becomes a transition)',
    erase: 'Click a street or node to delete it · V returns to select',
    direct: 'Direct selection — drag nodes to move/merge/weld, drag vertices to bend, right-click removes',
    marquee: 'Drag a box to select streets · Shift adds · Ctrl toggles · V returns to select',
    lasso: 'Draw around streets to select them · Shift adds · Ctrl toggles · V returns to select',
  };
  const STAGE_HINTS: Record<string, string> = {
    network: 'Drag to pan · scroll to zoom · click selects · drag a node onto another to merge',
    sections: 'Click a street to select it, then pick a section from the panel',
    junctions: 'Junction polygons are derived from the graph — pick one from the panel to zoom to it',
    mesh: mesh
      ? 'Every point exists once — drag a node and every abutting shape follows · pick tools from the panel'
      : 'Generate the mesh from the panel to freeze the design into editable shapes',
    detailing: placeKind
      ? `Click a street to place a ${placeKind} · drag to move it within its band · right-click to remove`
      : 'Pick an element from the palette, or drag/right-click existing ones · Esc deselects tool',
    edit: patchKind
      ? `Click to add ${patchKind} patch vertices · Enter/double-click closes · Esc cancels`
      : selectedShapeKey
        ? 'Drag any node of the outlined shape · right-click a node resets it · Esc deselects'
        : 'Click any generated surface to edit its nodes, or pick a material to draw a patch',
    export: 'Set up the title block in the panel, then print or download the plan',
  };
  const hint = boxDraw
    ? `Drag a rectangle to set the ${boxDraw} area · Esc cancels`
    : boundaryDraw
      ? 'Click along the plot/compound-wall line · double-click or Enter finishes · Esc cancels'
      : TOOL_HINTS[tool] ?? STAGE_HINTS[stage] ?? '';

  const previewPoints =
    tool === 'draw' && draft.length >= 1 && cursor
      ? [draft[draft.length - 1].x, draft[draft.length - 1].y, snap?.x ?? cursor.x, snap?.y ?? cursor.y]
      : null;

  const draftFlat = draft.flatMap((v) => [v.x, v.y]);

  const basemapActive = basemap !== 'none' && !!origin;

  return (
    <div
      ref={containerRef}
      className={basemapActive ? 'canvas-host with-basemap' : 'canvas-host'}
      style={{
        cursor:
          tool === 'draw' || tool === 'marquee' || tool === 'lasso' || !!boxDraw || boundaryDraw || (stage === 'edit' && patchKind)
            ? 'crosshair'
            : tool === 'split' || tool === 'erase'
              ? 'cell'
              : 'default',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {basemapActive && (
        <Basemap
          kind={basemap as 'osm' | 'sat'}
          origin={origin!}
          view={view}
          width={size.width}
          height={size.height}
        />
      )}
      <Stage
        width={size.width}
        height={size.height}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={(tool === 'select' || tool === 'direct') && !boxDraw}
        onDragMove={(e) => {
          // Konva moves the stage natively; React only needs the view for the
          // basemap + culling — sync at most once per animation frame.
          if (e.target === e.target.getStage()) {
            const x = e.target.x();
            const y = e.target.y();
            pendingViewRef.current = { x, y };
            if (viewRafRef.current === null) {
              viewRafRef.current = requestAnimationFrame(() => {
                viewRafRef.current = null;
                const p = pendingViewRef.current;
                if (p) setView((v) => ({ ...v, x: p.x, y: p.y }));
              });
            }
          }
        }}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            pendingViewRef.current = null;
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }
        }}
        onWheel={onWheel}
        onClick={onClick}
        // taps behave as clicks; touch events lack modifier keys, which the
        // handler already treats as falsy
        onTap={(e) => onClick(e as unknown as KonvaEventObject<MouseEvent>)}
        onDblClick={onDblClick}
        onDblTap={onDblClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {!basemapActive && <GridLayer view={view} width={size.width} height={size.height} />}
        {showSections && layers.junctions && !meshActive && (
          <ArtifactsLayer
            artifacts={visibleArtifacts}
            stage={stage}
            selectedJunctionKey={selectedJunctionKey}
            designOpacity={designOpacity}
            dimOthers={!!focusedJunction}
            showDetail={showDetail}
          />
        )}
        {!meshActive && (
          <EdgesLayer
            edges={visibleEdges}
            selectedEdgeIds={selectedEdgeIds}
            highlightEdges={highlightEdges}
            tool={tool}
            // roads layer off → fall back to centerline rendering
            showSections={showSections && layers.roads}
            trims={artifacts.trims}
            opacity={showSections && layers.roads ? designOpacity : 1}
            showDetail={showDetail && layers.markings}
          />
        )}
        {meshActive && mesh && layers.roads && (
          <MeshLayer
            mesh={mesh}
            interactive={stage === 'mesh'}
            selectedFaceId={selectedFaceId}
            meshPick={meshPick}
            meshTool={meshTool}
            scale={view.scale}
            viewRect={viewRect}
          />
        )}
        {stage === 'network' && (
          <VerticesLayer edges={visibleEdges} scale={view.scale} draggable={tool === 'direct'} />
        )}
        {stage === 'network' && (
          <NodesLayer
            nodes={visibleNodes}
            degrees={degrees}
            scale={view.scale}
            draggable={tool === 'direct'}
          />
        )}
        {boundaryList.length > 0 && layers.boundaries && (
          <BoundariesLayer
            boundaries={boundaryList}
            interactive={stage === 'network'}
            selectedBoundaryId={selectedBoundaryId}
            scale={view.scale}
          />
        )}
        {focusedJunction && <JunctionHandlesLayer j={focusedJunction} scale={view.scale} />}
        {stage === 'edit' && selectedShapeKey && selectedShapeBase && (
          <ShapeEditLayer
            shapeKey={selectedShapeKey}
            base={selectedShapeBase}
            weldMap={selectedShapeWeld}
            scale={view.scale}
          />
        )}
        {showSections && patchList.length > 0 && layers.patches && (
          <PatchesLayer
            patches={patchList}
            interactive={stage === 'edit'}
            selectedPatchId={selectedPatchId}
            scale={view.scale}
          />
        )}
        {showSections && Object.keys(elements).length > 0 && layers.furniture && (
          <DetailingLayer
            elements={visibleElements}
            edges={edges}
            dividerEdges={visibleEdges}
            trims={artifacts.trims}
            interactive={stage === 'detailing'}
            selectedElementId={selectedElementId}
            showDetail={showDetail && layers.markings}
          />
        )}
        <Layer listening={false}>
          {draftFlat.length >= 4 && (
            <Line points={draftFlat} stroke="#b3541e" strokeWidth={2} strokeScaleEnabled={false} />
          )}
          {boundaryDraw && boundaryDraft.length >= 2 && (
            <Line
              points={cursor ? [...boundaryDraft, cursor.x, cursor.y] : boundaryDraft}
              stroke="#8a5a2b"
              strokeWidth={1.8}
              dash={[9, 4, 2, 4]}
              strokeScaleEnabled={false}
            />
          )}
          {stage === 'edit' && patchDraft.length >= 2 && (
            <Line
              points={cursor ? [...patchDraft, cursor.x, cursor.y] : patchDraft}
              closed={patchDraft.length >= 6}
              stroke="#b3541e"
              strokeWidth={1.5}
              dash={[5, 4]}
              fill={patchDraft.length >= 6 ? 'rgba(217,122,46,0.10)' : undefined}
              strokeScaleEnabled={false}
            />
          )}
          {previewPoints && (
            <Line
              points={previewPoints}
              stroke="#b3541e"
              strokeWidth={1.5}
              dash={[5, 5]}
              strokeScaleEnabled={false}
            />
          )}
          {draft.map((v, i) => (
            <Circle key={i} x={v.x} y={v.y} radius={3 / view.scale} fill="#b3541e" />
          ))}
          {tool === 'draw' && snap && (
            <Ring
              x={snap.x}
              y={snap.y}
              innerRadius={4 / view.scale}
              outerRadius={6.5 / view.scale}
              fill={snap.type === 'node' ? '#0a8f4b' : '#b3541e'}
            />
          )}
          {region && boxDraw && region.length === 4 && (
            <Rect
              x={Math.min(region[0], region[2])}
              y={Math.min(region[1], region[3])}
              width={Math.abs(region[2] - region[0])}
              height={Math.abs(region[3] - region[1])}
              fill={boxDraw === 'import' ? 'rgba(21,90,138,0.08)' : 'rgba(44,124,63,0.08)'}
              stroke={boxDraw === 'import' ? '#155a8a' : '#2c7c3f'}
              strokeWidth={1.5}
              dash={[6, 4]}
              strokeScaleEnabled={false}
            />
          )}
          {!boxDraw && stage === 'network' && importBox && (
            <Rect
              x={importBox.minX}
              y={importBox.minY}
              width={importBox.maxX - importBox.minX}
              height={importBox.maxY - importBox.minY}
              stroke="#155a8a"
              strokeWidth={1.5}
              dash={[6, 4]}
              fill="rgba(21,90,138,0.05)"
              strokeScaleEnabled={false}
              listening={false}
            />
          )}
          {!boxDraw && stage === 'export' && exportBounds && (
            <Rect
              x={exportBounds.minX}
              y={exportBounds.minY}
              width={exportBounds.maxX - exportBounds.minX}
              height={exportBounds.maxY - exportBounds.minY}
              stroke="#2c7c3f"
              strokeWidth={1.5}
              dash={[6, 4]}
              fill="rgba(44,124,63,0.04)"
              strokeScaleEnabled={false}
              listening={false}
            />
          )}
          {region && !boxDraw && tool === 'marquee' && region.length === 4 && (
            <Rect
              x={Math.min(region[0], region[2])}
              y={Math.min(region[1], region[3])}
              width={Math.abs(region[2] - region[0])}
              height={Math.abs(region[3] - region[1])}
              fill="rgba(217,122,46,0.08)"
              stroke="#d97a2e"
              strokeWidth={1}
              dash={[4, 4]}
              strokeScaleEnabled={false}
            />
          )}
          {region && !boxDraw && tool === 'lasso' && region.length >= 4 && (
            <Line
              points={region}
              closed
              fill="rgba(217,122,46,0.08)"
              stroke="#d97a2e"
              strokeWidth={1}
              dash={[4, 4]}
              strokeScaleEnabled={false}
            />
          )}
        </Layer>
      </Stage>
      <div className="overlay fab-stack">
        <BasemapFab />
        <ScaleBar scale={view.scale} />
      </div>
      <CompassRose />
      <LayerRail />
      <PropertiesSidebar />
      <div className="overlay hint-pill">{hint}</div>
      <div className="overlay coords-pill" ref={coordsRef} />
    </div>
  );
}
