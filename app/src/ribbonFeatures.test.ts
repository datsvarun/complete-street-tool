import { beforeEach, describe, expect, it } from 'vitest';
import { useCst } from './store';
import { KIND_COLORS } from './catalog';
import { EMPTY_GRAPH } from './graph/ops';
import { KIND_HATCH, STYLE_PRESETS, svgFill, svgHatchDefs } from './style/kindStyles';

beforeEach(() => {
  useCst.setState({ ...EMPTY_GRAPH, stage: 'network', tool: 'select', draft: [], drawMode: 'line', mesh: null });
  useCst.getState().setStylePreset('pastel');
});

describe('arc draw mode', () => {
  it('commits one curved street on the third click', () => {
    const s = useCst.getState();
    s.setDrawMode('arc');
    s.setTool('draw');
    s.addDraftVert({ x: 0, y: 0, snap: null });
    s.addDraftVert({ x: 50, y: -30, snap: null });
    expect(Object.keys(useCst.getState().edges)).toHaveLength(0);
    s.addDraftVert({ x: 100, y: 0, snap: null });
    const edges = Object.values(useCst.getState().edges);
    expect(edges).toHaveLength(1);
    expect(edges[0].points.length / 2).toBeGreaterThan(10); // tessellated, not 3 clicks
    expect(useCst.getState().draft).toHaveLength(0);
  });

  it('line mode keeps collecting vertices', () => {
    const s = useCst.getState();
    s.setTool('draw');
    for (const x of [0, 50, 100]) s.addDraftVert({ x, y: 0, snap: null });
    expect(useCst.getState().draft).toHaveLength(3);
    expect(Object.keys(useCst.getState().edges)).toHaveLength(0);
  });
});

describe('importLines', () => {
  it('adds lines to the existing network instead of replacing it', () => {
    const s = useCst.getState();
    s.importLines([{ points: [0, 0, 100, 0] }], 'a.dxf');
    s.importLines([{ points: [0, 50, 100, 50] }], 'b.dxf');
    expect(Object.keys(useCst.getState().edges)).toHaveLength(2);
    expect(useCst.getState().statusMsg).toContain('b.dxf');
  });
});

describe('drawing style', () => {
  it('defaults to the pastel preset with hatches', () => {
    expect(useCst.getState().kindStyles).toEqual(STYLE_PRESETS.pastel);
    expect(KIND_COLORS.footpath).toBe(STYLE_PRESETS.pastel.footpath.color);
    expect(KIND_COLORS.carriageway).toBe('#bfbfbf');
    expect(KIND_HATCH.buffer).toBe('diagonal');
    expect(svgFill('buffer')).toBe('url(#hatch-buffer)');
    expect(svgFill('footpath')).toBe('#ffffff');
    expect(svgHatchDefs()).toContain('id="hatch-buffer"');
  });

  it('edits one kind without touching the others, and the live palette follows', () => {
    useCst.getState().setKindStyle('cycle', { color: '#112233', hatch: 'dots', ink: '#445566' });
    expect(KIND_COLORS.cycle).toBe('#112233');
    expect(KIND_HATCH.cycle).toBe('dots');
    expect(svgHatchDefs()).toContain('stroke="#445566"');
    expect(KIND_COLORS.footpath).toBe(STYLE_PRESETS.pastel.footpath.color);
  });

  it('the classic preset is flat', () => {
    useCst.getState().setStylePreset('classic');
    expect(KIND_COLORS.carriageway).toBe('#4a5560');
    expect(svgHatchDefs()).toBe('');
  });
});
