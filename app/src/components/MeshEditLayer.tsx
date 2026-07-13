// Edit-stage shared-node mesh editing (MESH_INTEGRATION_SPEC §2/§5): every
// welded mesh node is a handle. Hovering outlines every generated shape the
// node drives; dragging writes a world-space delta to the store per frame
// (undo history paused, so one drag = one undo step) and ALL abutting shapes
// — bands, junction ring, wedges — move together live, because they render
// from the same mesh view. Right-click a node resets its edit.
import { memo, useState } from 'react';
import { Circle, Layer, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useCst } from '../store';
import type { MeshView } from '../mesh/meshGeometry';

/** Beyond this many on-screen nodes the handles are noise (and a draw cost) —
 *  the user zooms in to edit. */
const MAX_VISIBLE_NODES = 4000;

interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function MeshEditLayerImpl({
  meshView,
  scale,
  viewRect,
}: {
  meshView: MeshView;
  scale: number;
  viewRect: ViewRect | null;
}) {
  const setMeshDelta = useCst((s) => s.setMeshDelta);
  const removeMeshDelta = useCst((s) => s.removeMeshDelta);
  const [active, setActive] = useState<number | null>(null); // hovered or dragged node
  const { mesh, xs, ys } = meshView;

  const visible: number[] = [];
  for (let id = 0; id < xs.length && visible.length <= MAX_VISIBLE_NODES; id++) {
    if (
      !viewRect ||
      (xs[id] >= viewRect.minX && xs[id] <= viewRect.maxX &&
        ys[id] >= viewRect.minY && ys[id] <= viewRect.maxY)
    ) {
      visible.push(id);
    }
  }
  const overloaded = visible.length > MAX_VISIBLE_NODES;

  const r = 3.2 / scale;
  const setCursor = (e: KonvaEventObject<MouseEvent>, cursor: string) => {
    e.target.getStage()!.container().style.cursor = cursor;
  };

  const dragTo = (id: number, wx: number, wy: number) => {
    setMeshDelta(mesh.nodeKeys[id], wx - mesh.xs[id], wy - mesh.ys[id]);
  };

  // Faces driven by the active node — the visual proof of shared topology.
  const activeFaces =
    active !== null
      ? mesh.nodeFaces[active].map((fi) => mesh.faces[fi].shapeKey)
      : [];

  return (
    <Layer>
      {activeFaces.map((shapeKey) => {
        const poly = meshView.polygon(shapeKey);
        if (!poly) return null;
        return (
          <Line
            key={`adj-${shapeKey}`}
            points={poly}
            closed
            stroke="#e08e45"
            strokeWidth={1.6}
            dash={[5, 3]}
            strokeScaleEnabled={false}
            listening={false}
          />
        );
      })}
      {!overloaded &&
        visible.map((id) => {
          const edited = meshView.editedNodes.has(id);
          const shared = mesh.nodeFaces[id].length > 1;
          return (
            <Circle
              key={id}
              x={xs[id]}
              y={ys[id]}
              radius={id === active ? r * 1.4 : r}
              fill={edited ? '#e08e45' : shared ? '#fff' : 'rgba(255,255,255,0.75)'}
              stroke={edited ? '#8a4413' : shared ? '#b3541e' : 'rgba(179,84,30,0.55)'}
              strokeWidth={1.4}
              strokeScaleEnabled={false}
              perfectDrawEnabled={false}
              draggable
              onMouseEnter={(e) => {
                setActive(id);
                setCursor(e, 'move');
              }}
              onMouseLeave={(e) => {
                setActive((a) => (a === id ? null : a));
                setCursor(e, '');
              }}
              onDragStart={() => {
                setActive(id);
                useCst.temporal.getState().pause();
              }}
              onDragMove={(ev) => dragTo(id, ev.target.x(), ev.target.y())}
              onDragEnd={(ev) => {
                useCst.temporal.getState().resume();
                dragTo(id, ev.target.x(), ev.target.y());
              }}
              onContextMenu={(ev) => {
                ev.evt.preventDefault();
                ev.cancelBubble = true;
                removeMeshDelta(mesh.nodeKeys[id]);
              }}
            />
          );
        })}
    </Layer>
  );
}

export const MeshEditLayer = memo(MeshEditLayerImpl);
