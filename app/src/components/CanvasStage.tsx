import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle, Ring, Rect, Arrow, Group } from 'react-konva';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCst } from '../store';
import { KIND_COLORS } from '../catalog';
import { refFraction } from '../geometry/ribbon';
import { Basemap } from './Basemap';
import { buildEdgeGeometry } from '../sections/transition';
import { offsetPolyline, projectOnPolyline, dist, toFlat, toPts, pointInPolygon } from '../geometry/polyline';
import { BasemapFab, ScaleBar, CompassRose } from './FloatingUI';
import { nodeClassOf } from '../types';
import type { GraphNode, Snap, StreetEdge, StreetElement, Tool } from '../types';
import { elementGraphics, laneDividers } from '../detailing/elements';
import { degree } from '../graph/ops';
import { deriveNodeArtifacts } from '../graph/junctions';
import type { EdgeTrim, JunctionPoly } from '../graph/junctions';

Konva.dragDistance = 3; // don't treat a pan drag as a click

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

const NODE_COLORS = {
  terminus: '#4CAF50',
  bend: '#2196F3',
  junction: '#FF9800',
  crossroads: '#F44336',
} as const;

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
}: {
  edge: StreetEdge;
  selected: boolean;
  highlighted: boolean;
  tool: Tool;
  showSections: boolean;
  trim?: EdgeTrim;
}) {
  const selectEdge = useCst((s) => s.selectEdge);
  const splitEdgeAt = useCst((s) => s.splitEdgeAt);
  const section = edge.section;
  const { bands, markings } = useMemo(
    () => (showSections ? buildEdgeGeometry(edge, trim) : { bands: [], markings: [] }),
    [edge, showSections, trim],
  );
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
    // Detailing: a click on the ribbon should place/select an element, not fall
    // through to edge selection — the band would otherwise eat the placement.
    if (st.stage === 'detailing') {
      const stageNode = e.target.getStage()!;
      const pos = stageNode.getPointerPosition()!;
      const wx = (pos.x - stageNode.x()) / stageNode.scaleX();
      const wy = (pos.y - stageNode.y()) / stageNode.scaleY();
      if (st.placeKind) {
        e.cancelBubble = true;
        st.placeElementAt(wx, wy, 40 / stageNode.scaleX());
      } else {
        e.cancelBubble = true;
        selectEdge(edge.id);
      }
      return;
    }
    if (tool === 'select') {
      e.cancelBubble = true;
      selectEdge(edge.id, e.evt.shiftKey ? 'add' : e.evt.ctrlKey || e.evt.metaKey ? 'toggle' : 'replace');
    } else if (tool === 'split') {
      e.cancelBubble = true;
      const stageNode = e.target.getStage()!;
      const pos = stageNode.getPointerPosition()!;
      const wx = (pos.x - stageNode.x()) / stageNode.scaleX();
      const wy = (pos.y - stageNode.y()) / stageNode.scaleY();
      splitEdgeAt(edge.id, wx, wy);
    }
  };
  const s = edgeStroke(edge, selected, highlighted, showSections && !!section);

  return (
    <>
      {bands.map((b) => (
        <Line
          key={`${edge.id}-${b.key}`}
          points={b.polygon}
          closed
          fill={KIND_COLORS[b.kind]}
          stroke="rgba(30,35,40,0.35)"
          strokeWidth={0.6}
          strokeScaleEnabled={false}
          onClick={onClick}
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
          listening={false}
        />
      ))}
      {markings.map((m) => (
        <Line
          key={`${edge.id}-${m.key}`}
          points={m.line}
          stroke="#f2f0e9"
          strokeWidth={1}
          dash={m.dashed ? [4, 4] : undefined}
          strokeScaleEnabled={false}
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
        onClick={onClick}
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
}: {
  edges: StreetEdge[];
  selectedEdgeIds: string[];
  highlightEdges: string[];
  tool: Tool;
  showSections: boolean;
  trims: Record<string, EdgeTrim>;
  opacity: number;
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
    for (const m of Object.values(state.nodes)) {
      if (m.id !== nodeId && dist(m.x, m.y, x, y) < tol) return { x: m.x, y: m.y, kind: 'node' as const };
    }
    for (const e of Object.values(state.edges)) {
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
          {...hoverCursor('move')}
          onDragStart={() => useCst.temporal.getState().pause()}
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
function VerticesLayerImpl({ edges, scale }: { edges: StreetEdge[]; scale: number }) {
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
              draggable
              onContextMenu={(ev) => {
                ev.evt.preventDefault();
                ev.cancelBubble = true;
                removeVertex(e.id, i);
              }}
              onDragStart={() => useCst.temporal.getState().pause()}
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

function findSnap(
  wx: number,
  wy: number,
  tol: number,
  nodes: Record<string, GraphNode>,
  edges: Record<string, StreetEdge>,
): Snap | null {
  let best: Snap | null = null;
  let bestD = tol;
  for (const n of Object.values(nodes)) {
    const d = dist(n.x, n.y, wx, wy);
    if (d < bestD) {
      bestD = d;
      best = { type: 'node', id: n.id, x: n.x, y: n.y };
    }
  }
  if (best) return best;
  for (const e of Object.values(edges)) {
    const proj = projectOnPolyline(e.points, wx, wy);
    if (proj && proj.dist < bestD) {
      bestD = proj.dist;
      best = { type: 'edge', id: e.id, x: proj.x, y: proj.y };
    }
  }
  return best;
}

/** Stage 3 elements: parametric symbols that drag along/across their edge but
 *  stay inside the component kinds their element type allows. */
function DetailingLayerImpl({
  elements,
  edges,
  trims,
  interactive,
  scale,
  selectedElementId,
}: {
  elements: StreetElement[];
  edges: Record<string, StreetEdge>;
  trims: Record<string, EdgeTrim>;
  interactive: boolean;
  scale: number;
  selectedElementId: string | null;
}) {
  const moveElement = useCst((s) => s.moveElement);
  const removeElement = useCst((s) => s.removeElement);
  const selectElement = useCst((s) => s.selectElement);
  const tol = 40;

  const dividers = useMemo(
    () =>
      Object.values(edges).flatMap((e) =>
        laneDividers(e, trims[e.id]).map((pts, i) => ({ key: `${e.id}-lane${i}`, pts })),
      ),
    [edges, trims],
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
        />
      ))}
      {elements.map((el) => {
        const edge = edges[el.edgeId];
        if (!edge) return null;
        const gfx = elementGraphics(edge, el);
        if (gfx.length === 0) return null;
        return (
          <Group
            key={el.id}
            draggable={interactive}
            {...(interactive ? hoverCursor('move') : {})}
            opacity={el.placedBy === 'suggest' ? 0.75 : 1}
            onClick={(ev) => {
              if (!interactive) return;
              ev.cancelBubble = true;
              selectElement(el.id);
            }}
            onDragStart={() => useCst.temporal.getState().pause()}
            onDragMove={(ev) => {
              const stageNode = ev.target.getStage()!;
              const pos = stageNode.getPointerPosition();
              if (!pos) return;
              moveElement(
                el.id,
                (pos.x - stageNode.x()) / stageNode.scaleX(),
                (pos.y - stageNode.y()) / stageNode.scaleY(),
                tol,
              );
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
            {el.id === selectedElementId && gfx[0] && (
              <Circle
                x={gfx[0].shape === 'circle' ? gfx[0].x : gfx[0].pts![0]}
                y={gfx[0].shape === 'circle' ? gfx[0].y : gfx[0].pts![1]}
                radius={8 / scale}
                stroke="#e08e45"
                strokeWidth={1.5}
                strokeScaleEnabled={false}
              />
            )}
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
                />
              ),
            )}
          </Group>
        );
      })}
    </Layer>
  );
}
const DetailingLayer = memo(DetailingLayerImpl);

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
  const designOpacity = useCst((s) => s.designOpacity);
  const highlightEdges = useCst((s) => s.highlightEdges);
  const draft = useCst((s) => s.draft);
  const pendingFit = useCst((s) => s.pendingFit);
  const addDraftVert = useCst((s) => s.addDraftVert);
  const finishDraft = useCst((s) => s.finishDraft);

  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const nodeList = useMemo(() => Object.values(nodes), [nodes]);
  const elementList = useMemo(() => Object.values(elements), [elements]);
  const degrees = useMemo(() => {
    const d: Record<string, number> = {};
    const g = { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 };
    for (const n of nodeList) d[n.id] = degree(g, n.id);
    return d;
  }, [nodes, edges, nodeList]);

  // Derived node artifacts (§1.2): junction polygons, node transitions, trims.
  const showSections = stage !== 'network';
  const artifacts = useMemo(
    () =>
      showSections
        ? deriveNodeArtifacts({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }, junctionDesigns)
        : { junctions: [], transitions: [], trims: {} },
    [nodes, edges, showSections, junctionDesigns],
  );
  const focusedJunction =
    stage === 'junctions' && selectedJunctionKey
      ? artifacts.junctions.find((j) => j.key === selectedJunctionKey) ?? null
      : null;

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

  const toWorld = (stageNode: Konva.Stage) => {
    const pos = stageNode.getPointerPosition();
    if (!pos) return null;
    return {
      x: (pos.x - stageNode.x()) / view.scale,
      y: (pos.y - stageNode.y()) / view.scale,
    };
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stageNode = e.target.getStage()!;
    const pos = stageNode.getPointerPosition();
    if (!pos) return;
    const factor = e.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const world = {
      x: (pos.x - stageNode.x()) / view.scale,
      y: (pos.y - stageNode.y()) / view.scale,
    };
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
    if ((tool !== 'marquee' && tool !== 'lasso') || e.evt.button !== 0) return;
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
    if (tool === 'draw') {
      const w = toWorld(stageNode);
      if (!w) return;
      const c = constrain(w, e.evt.shiftKey);
      // Compute the snap HERE, not from state: the mousemove preceding a fast
      // click may not have re-rendered yet, and a stale snap would duplicate
      // the previous vertex (which the stationary-dblclick check then eats).
      const s = findSnap(c.x, c.y, SNAP_PX / view.scale, nodes, edges);
      addDraftVert(s ? { x: s.x, y: s.y, snap: s } : { x: c.x, y: c.y, snap: null });
    } else if (stage === 'detailing' && placeKind) {
      const w = toWorld(stageNode);
      if (w) useCst.getState().placeElementAt(w.x, w.y, 40 / view.scale);
    } else if (tool === 'select' && e.target === stageNode) {
      if (stage === 'detailing') useCst.getState().selectElement(null);
      else if (stage === 'junctions') selectJunction(null);
      else useCst.getState().selectEdge(null);
    }
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const w = toWorld(e.target.getStage()!);
    if (!w) return;
    const r = regionRef.current;
    if (r) {
      if (tool === 'marquee') {
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
    setCursor(c);
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
    if (tool !== 'draw') return;
    const d = useCst.getState().draft;
    if (d.length < 2) return;
    const a = d[d.length - 2];
    const b = d[d.length - 1];
    if (dist(a.x, a.y, b.x, b.y) * view.scale < 6) finishDraft(1 / view.scale);
  };

  const hint =
    tool === 'draw'
      ? 'Click to add points (snaps to nodes/edges · Shift = 15° angles) · double-click or Enter to finish · Esc to cancel'
      : tool === 'split'
        ? 'Click a street to insert a node (a node between different sections becomes a transition)'
        : stage === 'sections'
          ? 'Click a street to select it, then pick a section from the panel'
          : stage === 'junctions'
            ? 'Junction polygons are derived from the graph — pick one from the panel to zoom to it'
            : stage === 'detailing'
              ? placeKind
                ? `Click a street to place a ${placeKind} · drag to move it within its band · right-click to remove`
                : 'Pick an element from the palette, or drag/right-click existing ones · Esc deselects tool'
              : 'Drag to pan · scroll to zoom · click selects · drag a node onto another to merge';

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
          tool === 'draw' || tool === 'marquee' || tool === 'lasso'
            ? 'crosshair'
            : tool === 'split'
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
        draggable={tool === 'select'}
        onDragMove={(e) => {
          // live view sync while panning so the basemap tracks the drag
          if (e.target === e.target.getStage()) {
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }
        }}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }
        }}
        onWheel={onWheel}
        onClick={onClick}
        onDblClick={onDblClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
      >
        {!basemapActive && <GridLayer view={view} width={size.width} height={size.height} />}
        {showSections && (
          <Layer listening={stage === 'junctions'} opacity={designOpacity}>
            {artifacts.junctions.flatMap((j) =>
              j.coverBands.map((b, bi) => (
                <Line key={`${j.nodeIds[0]}-cover${bi}`} points={b} closed fill="#525e6a" listening={false} />
              )),
            )}
            {artifacts.junctions.map((j) => (
              <Line
                key={j.key}
                points={j.polygon}
                closed
                fill="#525e6a"
                stroke={
                  stage === 'junctions'
                    ? j.key === selectedJunctionKey
                      ? '#e08e45'
                      : 'rgba(224,142,69,0.55)'
                    : 'rgba(30,35,40,0.4)'
                }
                strokeWidth={stage === 'junctions' ? (j.key === selectedJunctionKey ? 2 : 1) : 0.6}
                strokeScaleEnabled={false}
                opacity={focusedJunction && j.key !== selectedJunctionKey ? 0.45 : 1}
                onClick={stage === 'junctions' ? () => selectJunction(j.key) : undefined}
                {...(stage === 'junctions' ? hoverCursor('pointer') : {})}
              />
            ))}
            {artifacts.junctions.flatMap((j) =>
              j.wedges.map((b) => (
                <Line
                  key={`${j.nodeIds[0]}-${b.key}`}
                  points={b.polygon}
                  closed
                  fill={KIND_COLORS[b.kind]}
                  stroke="rgba(30,35,40,0.3)"
                  strokeWidth={0.5}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )),
            )}
            {artifacts.junctions.flatMap((j) =>
              j.noses.map((b) => (
                <Line
                  key={`${j.nodeIds[0]}-${b.key}`}
                  points={b.polygon}
                  closed
                  fill={KIND_COLORS[b.kind]}
                  stroke="rgba(30,35,40,0.3)"
                  strokeWidth={0.5}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )),
            )}
            {artifacts.transitions.flatMap((t) =>
              t.bands.map((b) => (
                <Line
                  key={`${t.nodeId}-${b.key}`}
                  points={b.polygon}
                  closed
                  fill={KIND_COLORS[b.kind]}
                  stroke="rgba(30,35,40,0.35)"
                  strokeWidth={0.6}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )),
            )}
          </Layer>
        )}
        <EdgesLayer
          edges={edgeList}
          selectedEdgeIds={selectedEdgeIds}
          highlightEdges={highlightEdges}
          tool={tool}
          showSections={showSections}
          trims={artifacts.trims}
          opacity={showSections ? designOpacity : 1}
        />
        {stage === 'network' && <VerticesLayer edges={edgeList} scale={view.scale} />}
        {stage === 'network' && (
          <NodesLayer
            nodes={nodeList}
            degrees={degrees}
            scale={view.scale}
            draggable={tool === 'select'}
          />
        )}
        {focusedJunction && <JunctionHandlesLayer j={focusedJunction} scale={view.scale} />}
        {showSections && Object.keys(elements).length > 0 && (
          <DetailingLayer
            elements={elementList}
            edges={edges}
            trims={artifacts.trims}
            interactive={stage === 'detailing'}
            scale={view.scale}
            selectedElementId={selectedElementId}
          />
        )}
        <Layer listening={false}>
          {draftFlat.length >= 4 && (
            <Line points={draftFlat} stroke="#b3541e" strokeWidth={2} strokeScaleEnabled={false} />
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
          {region && tool === 'marquee' && region.length === 4 && (
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
          {region && tool === 'lasso' && region.length >= 4 && (
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
      <div className="overlay hint-pill">{hint}</div>
      <div className="overlay coords-pill">
        {cursor ? `${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)} m` : ''}
      </div>
    </div>
  );
}
