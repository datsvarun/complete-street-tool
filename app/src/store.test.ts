import { beforeEach, describe, expect, it } from 'vitest';
import { useCst } from './store';

// Regression tests for the tool/box-draw/stage state machine — the stability
// fixes that keep transient modes mutually exclusive and from leaking across
// stage switches and imports.

beforeEach(() => {
  useCst.setState({
    stage: 'network',
    tool: 'select',
    boxDraw: null,
    importBox: null,
    exportBounds: null,
    patchDraft: [],
    patchKind: null,
    placeKind: null,
  });
});

describe('box-draw / tool mutual exclusivity', () => {
  it('arming a box forces the select tool', () => {
    useCst.setState({ tool: 'draw' });
    useCst.getState().setBoxDraw('export');
    expect(useCst.getState().tool).toBe('select');
    expect(useCst.getState().boxDraw).toBe('export');
  });

  it('picking a tool disarms box-draw', () => {
    useCst.getState().setBoxDraw('import');
    useCst.getState().setTool('lasso');
    expect(useCst.getState().boxDraw).toBeNull();
    expect(useCst.getState().tool).toBe('lasso');
  });
});

describe('setStage clears transient modes', () => {
  it('drops boxDraw, patch draft/material, and place kind', () => {
    useCst.setState({
      boxDraw: 'export',
      patchDraft: [0, 0, 10, 0, 10, 10],
      patchKind: 'footpath',
      placeKind: 'tree',
      tool: 'lasso',
    });
    useCst.getState().setStage('detailing');
    const s = useCst.getState();
    expect(s.boxDraw).toBeNull();
    expect(s.patchDraft).toEqual([]);
    expect(s.patchKind).toBeNull();
    expect(s.placeKind).toBeNull();
    expect(s.tool).toBe('select');
  });
});

describe('goTo re-anchor clears stale boxes', () => {
  it('drops importBox/exportBounds when re-anchoring an empty graph', () => {
    useCst.setState({
      edges: {},
      importBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      exportBounds: { minX: 0, minY: 0, maxX: 50, maxY: 50 },
    });
    useCst.getState().goTo({ lat: 12.9, lon: 77.6 }, 'Bengaluru');
    const s = useCst.getState();
    expect(s.importBox).toBeNull();
    expect(s.exportBounds).toBeNull();
    expect(s.origin).toEqual({ lat: 12.9, lon: 77.6 });
  });
});
