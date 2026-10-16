import { describe, expect, it } from 'vitest';
import { GERMANY_BBOX, GERMANY_POLYGONS } from './germany';
import {
  distanceToRingsKm,
  inBox,
  padBox,
  pointInMultiPolygon,
  pointInPolygon,
  pointInRing,
  type PolygonRings,
  type Ring,
} from './polygon';

/** Cities as [lat, lng]. */
const STUTTGART = [48.7758, 9.1829] as const;
const HAMBURG = [53.5511, 9.9937] as const;
const BERLIN = [52.52, 13.405] as const;
const PARIS = [48.8566, 2.3522] as const;
const VIENNA = [48.2082, 16.3738] as const;
const ZURICH = [47.3769, 8.5417] as const;
const AMSTERDAM = [52.3676, 4.9041] as const;

const SQUARE: Ring = [
  [0, 0],
  [0, 10],
  [10, 10],
  [10, 0],
];
const SQUARE_HOLE: Ring = [
  [4, 4],
  [4, 6],
  [6, 6],
  [6, 4],
];

describe('pointInRing', () => {
  it('ray casting: inside, outside, either side of a concave notch', () => {
    expect(pointInRing(5, 5, SQUARE)).toBe(true);
    expect(pointInRing(-1, 5, SQUARE)).toBe(false);
    expect(pointInRing(5, 11, SQUARE)).toBe(false);
    // A "U" shape: the notch between the arms is outside.
    const u: Ring = [
      [0, 0],
      [0, 9],
      [9, 9],
      [9, 6],
      [3, 6],
      [3, 3],
      [9, 3],
      [9, 0],
    ];
    expect(pointInRing(6, 4.5, u)).toBe(false);
    expect(pointInRing(6, 1.5, u)).toBe(true);
    expect(pointInRing(6, 7.5, u)).toBe(true);
  });

  it('gives the same answer for a ring with or without its closing point', () => {
    const closed: Ring = [...SQUARE, SQUARE[0]];
    for (const [lat, lng] of [
      [5, 5],
      [-1, 5],
      [10, 5],
      [5, 0],
    ] as const) {
      expect(pointInRing(lat, lng, closed)).toBe(pointInRing(lat, lng, SQUARE));
    }
  });

  it('counts a ray through a vertex once', () => {
    const diamond: Ring = [
      [0, 5],
      [5, 10],
      [10, 5],
      [5, 0],
    ];
    expect(pointInRing(5, 5, diamond)).toBe(true);
    expect(pointInRing(5, -1, diamond)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  it('a point inside a hole-free island polygon is inside', () => {
    expect(pointInPolygon(5, 5, [SQUARE])).toBe(true);
  });

  it('a point in a hole is outside, a point between outline and hole inside', () => {
    const withHole: PolygonRings = [SQUARE, SQUARE_HOLE];
    expect(pointInPolygon(5, 5, withHole)).toBe(false);
    expect(pointInPolygon(2, 2, withHole)).toBe(true);
    expect(pointInPolygon(11, 11, withHole)).toBe(false);
  });

  it('an empty polygon contains nothing', () => {
    expect(pointInPolygon(5, 5, [])).toBe(false);
  });
});

describe('pointInMultiPolygon on the Germany outline', () => {
  const inGermany = (p: readonly [number, number]) => pointInMultiPolygon(p[0], p[1], GERMANY_POLYGONS);

  it('Stuttgart, Hamburg and Berlin are inside', () => {
    expect(inGermany(STUTTGART)).toBe(true);
    expect(inGermany(HAMBURG)).toBe(true);
    expect(inGermany(BERLIN)).toBe(true);
  });

  it('Paris, Vienna, Zürich and Amsterdam are outside', () => {
    expect(inGermany(PARIS)).toBe(false);
    expect(inGermany(VIENNA)).toBe(false);
    expect(inGermany(ZURICH)).toBe(false);
    expect(inGermany(AMSTERDAM)).toBe(false);
  });

  it('island polygons (no holes) count: Fehmarn and Rügen, but not the sea between them', () => {
    const fehmarn = GERMANY_POLYGONS.find((p) => pointInPolygon(54.4369, 11.1953, p));
    expect(fehmarn).toBeDefined();
    expect(fehmarn).toHaveLength(1);
    expect(fehmarn).not.toBe(GERMANY_POLYGONS[0]);
    expect(inGermany([54.4167, 13.4333])).toBe(true); // Bergen auf Rügen
    expect(inGermany([54.6, 12.3])).toBe(false); // Baltic Sea
  });

  it('every point of the outline lies in the exported bounding box', () => {
    for (const polygon of GERMANY_POLYGONS) {
      for (const ring of polygon) for (const [lat, lng] of ring) expect(inBox(lat, lng, GERMANY_BBOX)).toBe(true);
    }
  });
});

describe('inBox / padBox', () => {
  it('includes the edges and grows on every side', () => {
    expect(inBox(0, 0, [[0, 0], [1, 1]])).toBe(true);
    expect(inBox(1.2, 0.5, [[0, 0], [1, 1]])).toBe(false);
    expect(padBox([[0, 0], [1, 1]], 0.5)).toEqual([
      [-0.5, -0.5],
      [1.5, 1.5],
    ]);
  });
});

describe('distanceToRingsKm', () => {
  it('measures to the nearest edge, also from inside', () => {
    // 0.1° of latitude south of the square's south edge is about 11.1 km.
    expect(distanceToRingsKm(-0.1, 5, [[SQUARE]])).toBeCloseTo(11.13, 1);
    // From the centre of the hole to its nearest edge: 1° of longitude at 5° N.
    expect(distanceToRingsKm(5, 5, [[SQUARE, SQUARE_HOLE]])).toBeCloseTo(111.32 * Math.cos((5 * Math.PI) / 180), 2);
    // Past the end of an edge, the distance is to the corner.
    expect(distanceToRingsKm(-0.1, -0.1, [[SQUARE]])).toBeCloseTo(Math.hypot(11.132, 11.132), 1);
  });
});
