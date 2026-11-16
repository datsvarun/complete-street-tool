import { useCst } from '../store';

export function MeshPanel() {
  const mesh = useCst((s) => s.mesh);
  const generateMesh = useCst((s) => s.generateMesh);
  const resetMesh = useCst((s) => s.resetMesh);

  return (
    <div className="panel">
      <h2>Mesh editing</h2>
      <p className="muted small">
        The whole design frozen into one shared-node mesh: every point exists
        once, every shape holds one function, abutting shapes share nodes —
        dragging the footpath/carriageway node reshapes both. Build bus bays,
        turn lanes, islands, parking bays, custom junctions here.
      </p>
      {!mesh ? (
        <button onClick={() => generateMesh()}>Generate mesh</button>
      ) : (
        <>
          <p className="muted small">
            {Object.keys(mesh.nodes).length} nodes · {mesh.faces.length} faces ·{' '}
            {mesh.editLog.length} edit(s)
          </p>
          <p className="muted small">
            The mesh tools and material dropdown live in the top toolbar; the
            selected shape's properties appear in the right sidebar.
          </p>

          <h3>Mesh lifecycle</h3>
          <p className="muted small">
            Changing streets/sections resets the mesh (you'll be asked when it
            has manual edits). Undo (Ctrl+Z) covers every mesh operation.
          </p>
          <div className="tool-row">
            <button
              onClick={() => {
                if (
                  mesh.editLog.length === 0 ||
                  window.confirm(`Regenerate and discard ${mesh.editLog.length} manual edit(s)?`)
                ) {
                  generateMesh();
                }
              }}
            >
              Regenerate
            </button>
            <button className="danger" onClick={() => resetMesh()}>
              Discard mesh
            </button>
          </div>
        </>
      )}
    </div>
  );
}
