import { describe, expect, it } from 'vitest';
import { applyShapeOverrides, deltaForDrag, fracKey, vertexFractions } from './vertexOverrides';

// unit square, closed
const SQUARE = [0, 0, 10, 0, 10, 10, 0, 10];

describe('vertexFractions', () => {
  it('spreads fractions by perimeter arc length', () => {
    expect(vertexFractions(SQUARE, true)).toEqual([0, 0.25, 0.5, 0.75]);
  });
});

describe('applyShapeOverrides', () => {
  it('returns the same array when nothing applies', () => {
    expect(applyShapeOverrides(SQUARE, undefined)).toBe(SQUARE);
    expect(applyShapeOverrides(SQUARE, {})).toBe(SQUARE);
  });

  it('applies a delta in the local tangent/normal frame', () => {
    // vertex 1 = (10,0); neighbours (0,0)→(10,10): tangent (1,1)/√2, y-down
    // left normal = (ty,-tx) = (1,-1)/√2
    const out = applyShapeOverrides(SQUARE, { [fracKey(0.25)]: { a: 0, c: Math.SQRT2 } });
    expect(out[2]).toBeCloseTo(11);
    expect(out[3]).toBeCloseTo(-1);
    // other vertices untouched
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(10);
  });

  it('matches keys after resampling (fraction drift within tolerance)', () => {
    const out = applyShapeOverrides(SQUARE, { '0.2610': { a: 0, c: Math.SQRT2 } });
    expect(out[2]).toBeCloseTo(11); // still lands on vertex 1 (0.25 ± 0.02)
  });

  it('skips stale keys (fraction with no nearby vertex)', () => {
    const out = applyShapeOverrides(SQUARE, { '0.1300': { a: 5, c: 5 } });
    expect(out).toEqual(SQUARE);
  });

  it('wraps fraction distance on closed outlines', () => {
    // 0.999 is within tolerance of vertex 0 (fraction 0) by wrap-around
    const out = applyShapeOverrides(SQUARE, { '0.9990': { a: 0, c: 1 } });
    expect(out[0]).not.toBe(SQUARE[0]);
  });
});

describe('deltaForDrag round-trip', () => {
  it('a drag stores a delta that re-applies to the dragged position', () => {
    const target = { x: 12.5, y: -1.5 };
    const { key, delta } = deltaForDrag(SQUARE, undefined, 1, target.x, target.y);
    const out = applyShapeOverrides(SQUARE, { [key]: delta });
    expect(out[2]).toBeCloseTo(target.x);
    expect(out[3]).toBeCloseTo(target.y);
  });

  it('reuses the existing key on subsequent drags', () => {
    const first = deltaForDrag(SQUARE, undefined, 1, 12, 0);
    const second = deltaForDrag(SQUARE, { [first.key]: first.delta }, 1, 14, 2);
    expect(second.key).toBe(first.key);
    const out = applyShapeOverrides(SQUARE, { [second.key]: second.delta });
    expect(out[2]).toBeCloseTo(14);
    expect(out[3]).toBeCloseTo(2);
  });
});
