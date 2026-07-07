import { useMemo } from 'react';
import { useCst } from '../store';
import { deriveNodeArtifactsCached } from '../graph/junctions';
import type { JunctionType } from '../types';

const TURN_LABEL: Record<string, string> = {
  left: 'left',
  through: 'through',
  right: 'right',
  uturn: 'U-turn',
};

export function JunctionsPanel() {
  const nodes = useCst((s) => s.nodes);
  const edges = useCst((s) => s.edges);
  const focusNode = useCst((s) => s.focusNode);
  const junctionDesigns = useCst((s) => s.junctionDesigns);
  const selectedJunctionKey = useCst((s) => s.selectedJunctionKey);
  const selectJunction = useCst((s) => s.selectJunction);
  const setJunctionType = useCst((s) => s.setJunctionType);
  const setCornerRadius = useCst((s) => s.setCornerRadius);
  const setApproachTrim = useCst((s) => s.setApproachTrim);
  const removeJunctionDesign = useCst((s) => s.removeJunctionDesign);

  const { junctions, transitions } = useMemo(
    () => deriveNodeArtifactsCached({ nodes, edges, nextNodeNum: 0, nextEdgeNum: 0 }, junctionDesigns),
    [nodes, edges, junctionDesigns],
  );
  const anySection = Object.values(edges).some((e) => e.section);

  const selected = junctions.find((j) => j.key === selectedJunctionKey) ?? null;
  const design = selected ? junctionDesigns[selected.key] : undefined;
  const staleKeys = Object.keys(junctionDesigns).filter((k) => !junctions.some((j) => j.key === k));

  const edgeLabel = (key: string) => {
    const [edgeId] = key.split(':');
    return edges[edgeId]?.name || edgeId;
  };

  return (
    <div className="panel">
      <h2>Junctions</h2>
      <p className="muted small">
        Fillet corners, wedges and trims are derived from the graph; drag the
        corner dots (radius) and mouth squares (trim) on a selected junction to
        override them. Right-click a dot toggles chamfer, Shift+right-click
        resets. Everything regenerates when the network changes.
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
          <li key={j.key}>
            <button
              className={j.key === selectedJunctionKey ? 'active' : ''}
              onClick={() => {
                selectJunction(j.key);
                focusNode(j.nodeIds[0]);
              }}
            >
              <strong>{j.nodeIds.length > 1 ? `${j.nodeIds[0]}+${j.nodeIds.length - 1}` : j.nodeIds[0]}</strong>
              {' '}· {j.degree}-way{j.nodeIds.length > 1 ? ' complex' : ''}
              {junctionDesigns[j.key]?.touched ? <span title="has manual overrides"> ✎</span> : null}
              <span className="muted small"> {j.names.slice(0, 2).join(' × ') || ''}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <>
          <h3>
            {selected.nodeIds.join('+')} · {selected.degree}-way
          </h3>
          <label className="small">
            Type{' '}
            <select
              value={design?.type ?? 'priority'}
              onChange={(e) => setJunctionType(selected.key, e.target.value as JunctionType)}
            >
              <option value="priority">priority</option>
              <option value="signalized">signalized</option>
              <option value="roundabout">roundabout</option>
            </select>
            <span className="muted"> (templates land in the next slice)</span>
          </label>

          <h3>Corners</h3>
          <ul className="edge-list">
            {selected.corners.map((c, i) => (
              <li key={c.key} className="row-between small">
                <span>
                  #{i + 1} {c.radiusM === null ? 'chamfer' : `R ${c.radiusM.toFixed(1)} m`}
                  {c.overridden ? ' ✎' : ''}
                </span>
                {c.overridden && (
                  <button className="mini" onClick={() => setCornerRadius(selected.key, c.key, null)}>
                    reset
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3>Approaches</h3>
          <ul className="edge-list">
            {selected.approachInfos.map((a) => (
              <li key={a.key} className="row-between small">
                <span>
                  {edgeLabel(a.key)} · trim {a.trim.toFixed(1)} m{a.overridden ? ' ✎' : ''}
                </span>
                {a.overridden && (
                  <button className="mini" onClick={() => setApproachTrim(selected.key, a.key, null)}>
                    reset
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3>Movements ({selected.movements.length})</h3>
          <p className="muted small">
            {(['left', 'through', 'right', 'uturn'] as const)
              .map((t) => `${selected.movements.filter((m) => m.turn === t).length} ${TURN_LABEL[t]}`)
              .join(' · ')}
            {' '}— shown as arrows on the canvas.
          </p>
        </>
      )}

      {staleKeys.length > 0 && (
        <>
          <h3>Stale overrides</h3>
          <p className="muted small">
            These junctions no longer exist in the network (nodes merged or
            deleted) but still carry manual overrides.
          </p>
          <ul className="edge-list">
            {staleKeys.map((k) => (
              <li key={k} className="row-between small">
                <span>{k}</span>
                <button className="mini" onClick={() => removeJunctionDesign(k)}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {transitions.length > 0 && (
        <>
          <h3>Section transitions ({transitions.length})</h3>
          <ul className="edge-list">
            {transitions.map((t) => (
              <li key={t.nodeId}>
                <button onClick={() => focusNode(t.nodeId)}>
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
