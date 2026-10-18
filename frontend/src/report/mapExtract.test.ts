import { describe, expect, it } from 'vitest';
import { fanOut, MAP_H, MAP_W, mapExtract, metresPerPixel, NUMBERED_MAX, project } from './mapExtract';

const TILES = 'https://tile.example/{z}/{x}/{y}.png';

describe('map extract', () => {
  it('Web Mercator: the origin is the world centre at every zoom', () => {
    expect(project(0, 0, 0)).toEqual([128, 128]);
    const [x, y] = project(7.94, 48.47, 15);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(metresPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
  });

  it('nothing to show without a position', () => {
    expect(mapExtract({ points: [] }, TILES)).toBeNull();
  });

  it('fits the points and the line in the frame, with the tiles that cover it', () => {
    const m = mapExtract(
      {
        points: [
          { no: 1, lat: 48.47, lng: 7.94, status: 'approved' },
          { no: 2, lat: 48.472, lng: 7.952, status: 'unreviewed' },
        ],
        line: [
          [
            [7.938, 48.469],
            [7.954, 48.473],
          ],
        ],
      },
      TILES,
    )!;
    expect(m.zoom).toBeGreaterThan(12);
    for (const p of m.points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(MAP_W);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(MAP_H);
    }
    expect(m.line).toMatch(/^M[\d.]+ [\d.]+L/);
    expect(m.tiles.length).toBeGreaterThan(0);
    expect(m.tiles[0].href).toMatch(new RegExp(`^https://tile\\.example/${m.zoom}/\\d+/\\d+\\.png$`));
    expect(m.numbered).toBe(true);
  });

  it('a circle keeps its radius in pixels', () => {
    const m = mapExtract({ points: [], area: { type: 'circle', center: [8, 48], radiusM: 500 } }, TILES)!;
    expect(m.area?.kind).toBe('circle');
    if (m.area?.kind === 'circle') expect(m.area.r * metresPerPixel(48, m.zoom)).toBeCloseTo(500, 0);
  });

  it('points on one spot fan out around it and keep their true position; many points are dots', () => {
    const fanned = fanOut([
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      { x: 300, y: 100 },
    ]);
    expect(fanned[2]).toMatchObject({ x: 300, y: 100, ax: 300, ay: 100 });
    expect(Math.hypot(fanned[0].x - fanned[1].x, fanned[0].y - fanned[1].y)).toBeGreaterThan(14);
    expect(fanned[0]).toMatchObject({ ax: 100, ay: 100 });
    const many = Array.from({ length: NUMBERED_MAX + 1 }, (_, i) => ({ no: i + 1, lat: 48 + i * 0.001, lng: 8, status: 'approved' }));
    expect(mapExtract({ points: many }, TILES)!.numbered).toBe(false);
  });
});
