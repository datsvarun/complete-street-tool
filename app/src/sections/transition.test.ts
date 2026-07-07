import { describe, expect, it } from 'vitest';
import type { SectionComponent } from '../types';
import { matchComponents } from './transition';

const C = (element: string, kind: SectionComponent['kind'], widthM: number): SectionComponent => ({
  element,
  kind,
  widthM,
});

const FP = C('Footpath', 'footpath', 3);
const CW = C('Carriageway', 'carriageway', 7);
const CYC = C('Cycle Track', 'cycle', 2);

describe('matchComponents', () => {
  it('is symmetric for reordered components (regression: cycle-track flip)', () => {
    const s1 = [FP, CW, CYC, FP];
    const s2 = [FP, CW, FP, CYC];
    const fwd = matchComponents(s1, s2);
    const back = matchComponents(s2, s1);
    // both directions keep the footpaths continuous and taper the cycle
    const cycFwd = fwd.filter((c) => c.kind === 'cycle');
    const cycBack = back.filter((c) => c.kind === 'cycle');
    expect(cycFwd.map((c) => [c.w1, c.w2])).toEqual(expect.arrayContaining([[2, 0], [0, 2]]));
    expect(cycBack.map((c) => [c.w1, c.w2])).toEqual(expect.arrayContaining([[2, 0], [0, 2]]));
    expect(fwd.filter((c) => c.kind === 'footpath').every((c) => c.w1 > 0 && c.w2 > 0)).toBe(true);
    expect(back.filter((c) => c.kind === 'footpath').every((c) => c.w1 > 0 && c.w2 > 0)).toBe(true);
  });

  it('merges a divided carriageway into a single one as a Y (both halves persist)', () => {
    const divided = [
      C('Verge', 'buffer', 2),
      C('Carriageway', 'carriageway', 7),
      C('Median', 'median', 2),
      C('Carriageway', 'carriageway', 7),
      C('Verge', 'buffer', 2),
    ];
    const single = [FP, C('Carriageway', 'carriageway', 7.5), FP];
    const m = matchComponents(divided, single);
    const cws = m.filter((c) => c.kind === 'carriageway');
    expect(cws).toHaveLength(2);
    // BOTH carriageways keep width at the single end (Y-merge, no taper-to-edge)
    expect(cws.every((c) => c.w2 > 0)).toBe(true);
    expect(cws.reduce((s, c) => s + c.w2, 0)).toBeCloseTo(7.5);
    // the median pinches out
    const med = m.find((c) => c.kind === 'median')!;
    expect(med.w2).toBe(0);
  });

  it('keeps the carriageway continuous across a section flip', () => {
    const s1 = [FP, CW, CYC, FP];
    const flipped = [...s1].reverse();
    const m = matchComponents(s1, flipped);
    const cw = m.filter((c) => c.kind === 'carriageway');
    expect(cw).toHaveLength(1);
    expect(cw[0].w1).toBe(7);
    expect(cw[0].w2).toBe(7);
  });
});
