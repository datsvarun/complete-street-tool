import { describe, expect, it } from 'vitest';
import { EMPTY_GRAPH } from '../graph/ops';
import { arcThrough } from '../geometry/polyline';
import { addLinesToGraph } from './lines';
import { geoJsonToLines, readGeoJsonLines } from './geojson';
import { centerLines, parseDxf } from './dxf';

describe('addLinesToGraph', () => {
  it('shares endpoints and nodes crossings', () => {
    const { g, added } = addLinesToGraph(EMPTY_GRAPH, [
      { points: [0, 0, 100, 0], name: 'Main' },
      { points: [100, 0, 100, 80] }, // shares the end node
      { points: [50, -40, 50, 40] }, // crosses Main
    ]);
    expect(added).toBeGreaterThanOrEqual(3);
    // 2 ends of Main + 1 far end + crossing node + 2 ends of the crossing line
    expect(Object.keys(g.nodes)).toHaveLength(6);
    expect(Object.values(g.edges).some((e) => e.name === 'Main')).toBe(true);
  });
});

describe('GeoJSON import', () => {
  it('reads LineString and MultiLineString features and projects to metres', () => {
    const parsed = readGeoJsonLines({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'A', highway: 'primary' },
          geometry: { type: 'LineString', coordinates: [[73.85, 18.52], [73.851, 18.52]] },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiLineString', coordinates: [[[73.85, 18.521], [73.85, 18.522]]] },
        },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [73.85, 18.52] } },
      ],
    })!;
    expect(parsed.lines).toHaveLength(2);
    const lines = geoJsonToLines(parsed, parsed.center);
    expect(lines[0].name).toBe('A');
    expect(lines[0].highway).toBe('primary');
    const [x0, , x1] = lines[0].points;
    expect(Math.abs(x1 - x0)).toBeGreaterThan(95); // 0.001° lon ≈ 105 m at 18.5°N
    expect(Math.abs(x1 - x0)).toBeLessThan(115);
  });

  it('rejects files with no lines or non-geographic coordinates', () => {
    expect(readGeoJsonLines({ type: 'FeatureCollection', features: [] })).toBeNull();
    expect(
      readGeoJsonLines({ type: 'LineString', coordinates: [[380000, 2050000], [380100, 2050000]] }),
    ).toBeNull();
  });
});

describe('DXF import', () => {
  const dxf = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '50000', '21', '0',
    '0', 'LWPOLYLINE', '90', '3', '70', '0', '10', '0', '20', '0', '10', '0', '20', '20000', '10', '10000', '20', '20000',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

  it('reads LINE and LWPOLYLINE, scales by $INSUNITS and flips y', () => {
    const lines = parseDxf(dxf).map((l) => l.points.map((v) => v + 0)); // -0 → 0
    expect(lines).toEqual([
      [0, 0, 50, 0],
      [0, 0, 0, -20, 10, -20],
    ]);
  });

  it('centres the drawing on a point', () => {
    const [l] = centerLines([{ points: [1000, 1000, 1100, 1000] }]);
    expect(l.points).toEqual([-50, 0, 50, 0]);
  });
});

describe('arcThrough', () => {
  it('passes through all three points on the circle', () => {
    const pts = arcThrough({ x: -10, y: 0 }, { x: 0, y: -10 }, { x: 10, y: 0 }, 1);
    expect(pts.slice(0, 2)).toEqual([-10, 0]);
    expect(pts.slice(-2)).toEqual([10, 0]);
    const ys = pts.filter((_, i) => i % 2 === 1);
    for (let i = 0; i + 1 < pts.length; i += 2) expect(Math.hypot(pts[i], pts[i + 1])).toBeCloseTo(10, 6);
    // goes via the middle point (negative-y side), not the long way round
    expect(Math.min(...ys)).toBeCloseTo(-10, 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1e-9);
  });

  it('falls back to a straight segment for collinear points', () => {
    expect(arcThrough({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toEqual([0, 0, 10, 0]);
  });
});
