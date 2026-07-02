import { useCst } from '../store';
import { getSection } from '../catalog';
import { polylineLength } from '../geometry/polyline';

export function NetworkPanel() {
  const { tool, edges, selectedEdgeId } = useCst();
  const setTool = useCst((s) => s.setTool);
  const selectEdge = useCst((s) => s.selectEdge);
  const deleteEdge = useCst((s) => s.deleteEdge);

  return (
    <div className="panel">
      <h2>Network</h2>
      <p className="muted">
        Draw street centerlines. Import, snapping and cleaning tools arrive in
        Phase 1.
      </p>
      <div className="tool-row">
        <button
          className={tool === 'select' ? 'active' : ''}
          onClick={() => setTool('select')}
        >
          Select
        </button>
        <button
          className={tool === 'draw' ? 'active' : ''}
          onClick={() => setTool('draw')}
        >
          Draw street
        </button>
      </div>

      <h3>Streets ({edges.length})</h3>
      {edges.length === 0 && (
        <p className="muted">Nothing yet — pick “Draw street” and click on the canvas.</p>
      )}
      <ul className="edge-list">
        {edges.map((e) => (
          <li key={e.id}>
            <button
              className={e.id === selectedEdgeId ? 'active' : ''}
              onClick={() => selectEdge(e.id)}
            >
              <strong>{e.id}</strong> · {polylineLength(e.points).toFixed(0)} m
              <span className="muted">
                {' '}
                {getSection(e.sectionId)?.rowWidthM
                  ? `· ${getSection(e.sectionId)!.rowWidthM} m ROW`
                  : '· no section'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selectedEdgeId && (
        <button className="danger" onClick={() => deleteEdge(selectedEdgeId)}>
          Delete {selectedEdgeId}
        </button>
      )}
    </div>
  );
}
