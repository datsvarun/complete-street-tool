import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle, Ring } from 'react-konva';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCst } from '../store';
import { getSection, KIND_COLORS } from '../catalog';
import { buildRibbon } from '../geometry/ribbon';
import { projectOnPolyline, dist } from '../geometry/polyline';
import { nodeClassOf } from '../types';
import type { GraphNode, Snap, StreetEdge, Tool } from '../types';
import { degree } from '../graph/ops';

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
}: {
  edge: StreetEdge;
  selected: boolean;
  highlighted: boolean;
  tool: Tool;
}) {
  const selectEdge = useCst((s) => s.selectEdge);
  const splitEdgeAt = useCst((s) => s.splitEdgeAt);
  const section = getSection(edge.sectionId);
  const bands = useMemo(
    () => (section ? buildRibbon(edge.points, section) : []),
    [edge.points, section],
  );
  const onClick = (e: KonvaEventObject<MouseEvent>) => {
    if (tool === 'select') {
      e.cancelBubble = true;
      selectEdge(edge.id);
    } else if (tool === 'split') {
      e.cancelBubble = true;
      const stageNode = e.target.getStage()!;
      const pos = stageNode.getPointerPosition()!;
      const wx = (pos.x - stageNode.x()) / stageNode.scaleX();
      const wy = (pos.y - stageNode.y()) / stageNode.scaleY();
      splitEdgeAt(edge.id, wx, wy);
    }
  };
  const s = edgeStroke(edge, selected, highlighted, !!section);

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
        />
      ))}
      <Line
        points={edge.points}
        stroke={s.stroke}
        strokeWidth={s.width}
        dash={section && !selected ? [6, 6] : edge.carriagewayType === 'divided' ? [10, 4] : undefined}
        strokeScaleEnabled={false}
        hitStrokeWidth={12}
        onClick={onClick}
      />
    </>
  );
}

function EdgesLayerImpl({
  edges,
  selectedEdgeId,
  highlightEdges,
  tool,
}: {
  edges: StreetEdge[];
  selectedEdgeId: string | null;
  highlightEdges: string[];
  tool: Tool;
}) {
  return (
    <Layer>
      {edges.map((e) => (
        <EdgeShape
          key={e.id}
          edge={e}
          selected={e.id === selectedEdgeId}
          highlighted={highlightEdges.includes(e.id)}
          tool={tool}
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
  const r = 3.5 / scale;
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
          onDragStart={() => useCst.temporal.getState().pause()}
          onDragMove={(e) => moveNodeTo(n.id, e.target.x(), e.target.y())}
          onDragEnd={(e) => {
            useCst.temporal.getState().resume();
            const x = e.target.x();
            const y = e.target.y();
            moveNodeTo(n.id, x, y);
            // Drop onto another node → merge (Plan v2 §2.3 cleaning toolkit)
            const tol = NODE_MERGE_PX / scale;
            const target = Object.values(useCst.getState().nodes).find(
              (m) => m.id !== n.id && dist(m.x, m.y, x, y) < tol,
            );
            if (target) mergeNodePair(target.id, n.id);
          }}
        />
      ))}
    </Layer>
  );
}
const NodesLayer = memo(NodesLayerImpl);

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

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 5 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const centeredRef = useRef(false);

  const stage = useCst((s) => s.stage);
  const tool = useCst((s) => s.tool);
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const selectedEdgeId = useCst((s) => s.selectedEdgeId);
  const highlightEdges = useCst((s) => s.highlightEdges);
  const draft = useCst((s) => s.draft);
  const pendingFit = useCst((s) => s.pendingFit);
  const addDraftVert = useCst((s) => s.addDraftVert);
  const finishDraft = useCst((s) => s.finishDraft);

  const edgeList = useMemo(() => Object.values(edges), [edges]);
  const nodeList = useMemo(() => Object.values(nodes), [nodes]);
  const degrees = useMemo(() => {
    const d: Record<string, number> = {};
    const g = { nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 };
    for (const n of nodeList) d[n.id] = degree(g, n.id);
    return d;
  }, [nodes, edges, nodeList]);

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

  const onClick = (e: KonvaEventObject<MouseEvent>) => {
    const stageNode = e.target.getStage()!;
    if (tool === 'draw') {
      const w = toWorld(stageNode);
      if (!w) return;
      const c = constrain(w, e.evt.shiftKey);
      const s = snap ?? findSnap(c.x, c.y, SNAP_PX / view.scale, nodes, edges);
      addDraftVert(s ? { x: s.x, y: s.y, snap: s } : { x: c.x, y: c.y, snap: null });
    } else if (tool === 'select' && e.target === stageNode) {
      useCst.getState().selectEdge(null);
    }
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const w = toWorld(e.target.getStage()!);
    if (!w) return;
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
        ? 'Click a street to insert a node'
        : stage === 'sections'
          ? 'Click a street to select it, then pick a section from the panel'
          : 'Drag to pan · scroll to zoom · click selects · drag a node onto another to merge';

  const previewPoints =
    tool === 'draw' && draft.length >= 1 && cursor
      ? [draft[draft.length - 1].x, draft[draft.length - 1].y, snap?.x ?? cursor.x, snap?.y ?? cursor.y]
      : null;

  const draftFlat = draft.flatMap((v) => [v.x, v.y]);

  return (
    <div
      ref={containerRef}
      className="canvas-host"
      style={{ cursor: tool === 'draw' ? 'crosshair' : tool === 'split' ? 'cell' : 'grab' }}
    >
      <Stage
        width={size.width}
        height={size.height}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={tool === 'select'}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }
        }}
        onWheel={onWheel}
        onClick={onClick}
        onDblClick={onDblClick}
        onMouseMove={onMouseMove}
      >
        <GridLayer view={view} width={size.width} height={size.height} />
        <EdgesLayer
          edges={edgeList}
          selectedEdgeId={selectedEdgeId}
          highlightEdges={highlightEdges}
          tool={tool}
        />
        {stage === 'network' && (
          <NodesLayer
            nodes={nodeList}
            degrees={degrees}
            scale={view.scale}
            draggable={tool === 'select'}
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
        </Layer>
      </Stage>
      <div className="status-bar">
        <span>{cursor ? `x ${cursor.x.toFixed(1)} m · y ${cursor.y.toFixed(1)} m` : '—'}</span>
        <span>{view.scale.toFixed(1)} px/m</span>
        <span className="hint">{hint}</span>
      </div>
    </div>
  );
}
