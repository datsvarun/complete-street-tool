import { useMemo, useState } from 'react';
import { useCst } from '../store';
import { deriveNodeArtifacts } from '../graph/junctions';

export function JunctionsPanel() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const focusNode = useCst((s) => s.focusNode);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { junctions, transitions } = useMemo(
    () => deriveNodeArtifacts({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }),
    [nodes, edges],
  );
  const anySection = Object.values(edges).some((e) => e.section);

  return (
    <div className="panel">
      <h2>Junctions</h2>
      <p className="muted small">
        Plain junction polygons for now (osm2streets corner method) — types,
        templates and editing primitives come in the next phase. Polygons
        regenerate automatically when the network or sections change.
      </p>
      {!anySection && (
        <p className="muted small">
          ⚠ No sections assigned yet — junction shapes use a fallback width.
          Assign sections in Stage 2 for accurate geometry.
        </p>
      )}

      <h3>Junctions ({junctions.length})</h3>
      <ul className="edge-list tall">
        {junctions.map((j) => (
          <li key={j.nodeIds.join('+')}>
            <button
              className={j.nodeIds[0] === activeId ? 'active' : ''}
              onClick={() => {
                setActiveId(j.nodeIds[0]);
                focusNode(j.nodeIds[0]);
              }}
            >
              <strong>{j.nodeIds.length > 1 ? `${j.nodeIds[0]}+${j.nodeIds.length - 1}` : j.nodeIds[0]}</strong>
              {' '}· {j.degree}-way{j.nodeIds.length > 1 ? ' complex' : ''}
              <span className="muted small"> {j.names.slice(0, 2).join(' × ') || ''}</span>
            </button>
          </li>
        ))}
      </ul>

      {transitions.length > 0 && (
        <>
          <h3>Section transitions ({transitions.length})</h3>
          <ul className="edge-list">
            {transitions.map((t) => (
              <li key={t.nodeId}>
                <button
                  className={t.nodeId === activeId ? 'active' : ''}
                  onClick={() => {
                    setActiveId(t.nodeId);
                    focusNode(t.nodeId);
                  }}
                >
                  <strong>{t.nodeId}</strong>
                  <span className="muted small"> smooth section change</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
