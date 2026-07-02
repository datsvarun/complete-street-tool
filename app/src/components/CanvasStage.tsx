import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle } from 'react-konva';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCst } from '../store';
import { getSection, KIND_COLORS } from '../catalog';
import { buildRibbon } from '../geometry/ribbon';
import type { StreetEdge, Stage as CstStage, Tool } from '../types';

Konva.dragDistance = 3; // don't treat a pan drag as a click

interface View {
  x: number;
  y: number;
  scale: number; // px per metre
}

const GRID_STEP = 10; // metres
const MIN_SCALE = 0.4;
const MAX_SCALE = 60;

function GridLayerImpl({ view, width, height }: { view: View; width: number; height: number }) {
  const lines = useMemo(() => {
    const x0 = -view.x / view.scale;
    const y0 = -view.y / view.scale;
    const x1 = x0 + width / view.scale;
    const y1 = y0 + height / view.scale;
    const out: Array<{ key: string; pts: number[]; axis: boolean }> = [];
    for (let x = Math.floor(x0 / GRID_STEP) * GRID_STEP; x <= x1; x += GRID_STEP) {
      out.push({ key: `v${x}`, pts: [x, y0, x, y1], axis: x === 0 });
    }
    for (let y = Math.floor(y0 / GRID_STEP) * GRID_STEP; y <= y1; y += GRID_STEP) {
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

function EdgeShape({
  edge,
  selected,
  stage,
  tool,
  scale,
}: {
  edge: StreetEdge;
  selected: boolean;
  stage: CstStage;
  tool: Tool;
  scale: number;
}) {
  const selectEdge = useCst((s) => s.selectEdge);
  const section = getSection(edge.sectionId);
  const bands = useMemo(
    () => (section ? buildRibbon(edge.points, section) : []),
    [edge.points, section],
  );
  const onSelect = (e: KonvaEventObject<MouseEvent>) => {
    if (tool !== 'select') return;
    e.cancelBubble = true;
    selectEdge(edge.id);
  };
  const endpoints = [
    [edge.points[0], edge.points[1]],
    [edge.points[edge.points.length - 2], edge.points[edge.points.length - 1]],
  ];

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
          onClick={onSelect}
        />
      ))}
      <Line
        points={edge.points}
        stroke={
          selected
            ? '#e08e45'
            : section
              ? 'rgba(255,255,255,0.85)'
              : '#1c2733'
        }
        strokeWidth={selected ? 2.5 : section ? 1.2 : 2}
        dash={section && !selected ? [6, 6] : undefined}
        strokeScaleEnabled={false}
        hitStrokeWidth={14}
        onClick={onSelect}
      />
      {stage === 'network' &&
        endpoints.map(([x, y], i) => (
          <Circle
            key={`${edge.id}-n${i}`}
            x={x}
            y={y}
            radius={3.5 / scale}
            fill={selected ? '#e08e45' : '#1c2733'}
            listening={false}
          />
        ))}
    </>
  );
}

function EdgesLayerImpl({
  edges,
  selectedEdgeId,
  stage,
  tool,
  scale,
}: {
  edges: StreetEdge[];
  selectedEdgeId: string | null;
  stage: CstStage;
  tool: Tool;
  scale: number;
}) {
  return (
    <Layer>
      {edges.map((e) => (
        <EdgeShape
          key={e.id}
          edge={e}
          selected={e.id === selectedEdgeId}
          stage={stage}
          tool={tool}
          scale={scale}
        />
      ))}
    </Layer>
  );
}
const EdgesLayer = memo(EdgesLayerImpl);

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 5 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const centeredRef = useRef(false);

  const { stage, tool, edges, selectedEdgeId, draft } = useCst();
  const addDraftPoint = useCst((s) => s.addDraftPoint);
  const finishDraft = useCst((s) => s.finishDraft);

  useEffect(() => {
    const el = containerRef.current!;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
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

  const onClick = (e: KonvaEventObject<MouseEvent>) => {
    const stageNode = e.target.getStage()!;
    if (tool === 'draw') {
      const w = toWorld(stageNode);
      if (w) addDraftPoint(w.x, w.y);
    } else if (e.target === stageNode) {
      useCst.getState().selectEdge(null);
    }
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const w = toWorld(e.target.getStage()!);
    if (w) setCursor(w);
  };

  // Konva synthesizes dblclick from ANY two clicks within its time window, even far
  // apart — rapid vertex clicking must not finish the street. Only finish when the
  // double-click is stationary: the last two draft points (click fires before
  // dblclick, so the duplicate is already in the draft) nearly coincide on screen.
  const onDblClick = () => {
    if (tool !== 'draw') return;
    const d = useCst.getState().draft;
    const n = d.length;
    if (n < 4) return;
    const distPx =
      Math.hypot(d[n - 2] - d[n - 4], d[n - 1] - d[n - 3]) * view.scale;
    if (distPx < 6) finishDraft();
  };

  const hint =
    tool === 'draw'
      ? 'Click to add points · double-click or Enter to finish · Esc to cancel'
      : stage === 'sections'
        ? 'Click a street to select it, then pick a section from the panel'
        : 'Drag to pan · scroll to zoom · click a street to select';

  const previewPoints =
    tool === 'draw' && draft.length >= 2 && cursor
      ? [draft[draft.length - 2], draft[draft.length - 1], cursor.x, cursor.y]
      : null;

  return (
    <div
      ref={containerRef}
      className="canvas-host"
      style={{ cursor: tool === 'draw' ? 'crosshair' : 'grab' }}
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
          edges={edges}
          selectedEdgeId={selectedEdgeId}
          stage={stage}
          tool={tool}
          scale={view.scale}
        />
        <Layer listening={false}>
          {draft.length >= 4 && (
            <Line
              points={draft}
              stroke="#b3541e"
              strokeWidth={2}
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
          {toPtsPairs(draft).map(([x, y], i) => (
            <Circle
              key={i}
              x={x}
              y={y}
              radius={3 / view.scale}
              fill="#b3541e"
            />
          ))}
        </Layer>
      </Stage>
      <div className="status-bar">
        <span>
          {cursor
            ? `x ${cursor.x.toFixed(1)} m · y ${cursor.y.toFixed(1)} m`
            : '—'}
        </span>
        <span>{view.scale.toFixed(1)} px/m</span>
        <span className="hint">{hint}</span>
      </div>
    </div>
  );
}

function toPtsPairs(flat: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}
