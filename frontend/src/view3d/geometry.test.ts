import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { Borehole, GroundwaterReading } from '../domain/types';
import { makeBorehole, makeLayer, makeValue } from '../test/fixtures';
import {
  buildScene,
  columnRadius,
  connectRuns,
  defaultExaggeration,
  exaggerationMax,
  EXAGGERATION_LIMIT,
  neighbourSpacing,
  radiusOnScreen,
  dinColor,
  EXAGGERATION_FALLBACK,
  fitView,
  groundTiles,
  hexToRgb,
  levelLabel,
  localFrame,
  M_PER_DEG,
  MAX_BOREHOLES,
  representativeReading,
  tileBounds,
  tileUrl,
  tin,
  toLocal,
  type Vec3,
} from './geometry';

// Fictional boreholes only.
type Gw = Partial<GroundwaterReading> & Pick<GroundwaterReading, 'type'>;
interface Opts {
  lat?: number | null;
  lng?: number | null;
  gl?: number;
  depth?: number | null;
  layers?: Borehole['layers'];
  gw?: Gw[];
  rock?: number;
  onMap?: boolean;
  datum?: string;
}

function bh(uid: string, o: Opts = {}): Borehole {
  const b = makeBorehole({ uid, id: uid.toUpperCase(), finalDepth: o.depth === undefined ? 6 : o.depth });
  return {
    ...b,
    lat: o.lat === undefined ? 48 : o.lat,
    lng: o.lng === undefined ? 11 : o.lng,
    onMap: o.onMap ?? true,
    layers: o.layers ?? b.layers,
    logBottom: Math.max(0, ...(o.layers ?? b.layers).map((l) => l.to)),
    rockHead: o.rock ?? null,
    groundwater: (o.gw ?? []).map((g, i) => ({ depth: null, elevation: null, date: null, raw: null, key: K.gw(i), ...g })),
    meta: o.gl != null ? { ...b.meta, elevationDatum: o.datum ?? 'NN' } : b.meta,
    values: o.gl != null ? [...b.values, makeValue({ key: K.elevation, value: String(o.gl), unit: 'm' })] : b.values,
  };
}

/** Degrees of longitude for `m` metres east at latitude 48 (frame approximation). */
const dLon = (m: number) => m / (M_PER_DEG * Math.cos((48 * Math.PI) / 180));
const dLat = (m: number) => m / M_PER_DEG;

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

describe('local frame', () => {
  it('is within 0.5 % of the haversine distance over 5 km in both directions at latitude 48', () => {
    const pts = [
      { lat: 48, lng: 11 },
      { lat: 48, lng: 11 + dLon(5000) },
      { lat: 48 + dLat(5000), lng: 11 },
      { lat: 48 - dLat(5000), lng: 11 - dLon(5000) },
      { lat: 48.03, lng: 11.05 },
    ];
    const f = localFrame(pts);
    expect(f.lat0).toBeCloseTo(pts.reduce((s, p) => s + p.lat, 0) / pts.length, 9);
    expect(f.lon0).toBeCloseTo(pts.reduce((s, p) => s + p.lng, 0) / pts.length, 9);
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const a = toLocal(f, pts[i].lng, pts[i].lat);
        const b = toLocal(f, pts[j].lng, pts[j].lat);
        const local = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const true_ = haversine(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng);
        expect(Math.abs(local - true_) / true_).toBeLessThan(0.005);
      }
    const [e, n] = toLocal(f, f.lon0, f.lat0);
    expect(e).toBe(0);
    expect(n).toBe(0);
  });
});

describe('columns', () => {
  const layers = [makeLayer({ n: 1, from: 0, to: 2, din: 'S' }), makeLayer({ n: 2, from: 2, to: 5, din: 'T' }), makeLayer({ n: 3, from: 5, to: 5, din: 'G' })];

  it('depth mode: tops and bottoms from z = 0, scaled by the exaggeration; empty layers skipped', () => {
    for (const k of [1, 5]) {
      const s = buildScene([bh('a', { layers, depth: 5 })], { mode: 'depth', exaggeration: k, kind: 'set' });
      expect(s.mode).toBe('depth');
      expect(s.segments.map((g) => g.n)).toEqual([1, 2]);
      const [s1, s2] = s.segments;
      expect(s1.position[2] + s1.height).toBeCloseTo(0, 9);
      expect(s1.position[2]).toBeCloseTo(-2 * k, 9);
      expect(s2.position[2] + s2.height).toBeCloseTo(-2 * k, 9);
      expect(s2.position[2]).toBeCloseTo(-5 * k, 9);
      expect(s2).toMatchObject({ from: 2, to: 5, din: 'T', kind: 'layer', ghost: false });
      expect(s1.color[3]).toBe(255);
      expect(s.boreholes[0]).toMatchObject({ collarZ: 0, depth: 5, placed: true });
      expect(s.notLogged).toBe(false);
    }
  });

  it('elevation mode: collars stand at their ground level above the lowest one', () => {
    for (const k of [1, 5]) {
      const recs = [bh('a', { gl: 100, layers, depth: 5 }), bh('b', { gl: 103, layers, depth: 5, lng: 11.001 })];
      const s = buildScene(recs, { mode: 'elevation', exaggeration: k, kind: 'set' });
      expect(s.mode).toBe('elevation');
      expect(s.base).toBe(100);
      expect(s.datum).toBe('NN');
      expect(s.boreholes.map((b) => b.collarZ)).toEqual([0, 3 * k]);
      const b2 = s.segments.filter((g) => g.uid === 'b');
      expect(b2[0].position[2] + b2[0].height).toBeCloseTo(3 * k, 9);
      expect(b2[1].position[2]).toBeCloseTo(3 * k - 5 * k, 9);
      expect(b2[1].height).toBeCloseTo(3 * k, 9);
    }
  });

  it('a final depth below the last layer gets a "not logged" tail; no layers is one tail', () => {
    const s = buildScene(
      [bh('a', { layers: [makeLayer({ n: 1, from: 0, to: 4 })], depth: 7 }), bh('b', { layers: [], depth: 3, lng: 11.001 }), bh('c', { layers: [makeLayer({ n: 1, from: 0, to: 4 })], depth: 4.004, lng: 11.002 })],
      { mode: 'depth', exaggeration: 2, kind: 'set' },
    );
    const tails = s.segments.filter((g) => g.kind === 'notLogged');
    expect(tails.map((t) => [t.uid, t.from, t.to, t.n, t.din])).toEqual([
      ['a', 4, 7, 0, null],
      ['b', 0, 3, 0, null],
    ]);
    expect(tails[0].position[2]).toBeCloseTo(-14, 9);
    expect(tails[0].height).toBeCloseTo(6, 9);
    expect(tails[0].color[3]).toBe(70);
    expect(s.notLogged).toBe(true);
  });

  it('colours: DIN colour, white for A, grey for a missing or unknown code; legend and uncoded', () => {
    expect(dinColor('A')).toEqual([255, 255, 255, 255]);
    expect(dinColor(null)).toEqual(hexToRgb('#E0E0E0'));
    expect(dinColor('NOT-A-CODE', 90)).toEqual([224, 224, 224, 90]);
    expect(hexToRgb('#0a0B0c', 7)).toEqual([10, 11, 12, 7]);
    const s = buildScene([bh('a', { layers: [makeLayer({ n: 1, from: 0, to: 1, din: null }), makeLayer({ n: 2, from: 1, to: 6, din: 'T' })] })], { mode: 'depth', exaggeration: 1, kind: 'set' });
    expect(s.uncoded).toBe(true);
    expect(s.legend.map((l) => l.code)).toEqual(['T']);
    expect(s.segments[0].color).toEqual([224, 224, 224, 255]);
  });
});

describe('groundwater', () => {
  it('representative reading: rest, standpipe, strike; other never; dated and latest first', () => {
    const r = (type: GroundwaterReading['type'], date: string | null = null) => ({ type, date });
    expect(representativeReading([r('strike'), r('standpipe'), r('rest')])?.type).toBe('rest');
    expect(representativeReading([r('strike'), r('standpipe')])?.type).toBe('standpipe');
    expect(representativeReading([r('other'), r('strike')])?.type).toBe('strike');
    expect(representativeReading([r('other')])).toBeNull();
    expect(representativeReading([])).toBeNull();
    const undated = r('rest');
    const old = r('rest', '2020-04-01');
    const late = r('rest', '03.05.2021');
    expect(representativeReading([undated, old, late])).toBe(late);
    expect(representativeReading([undated, r('rest', 'n/a')])).toBe(undated);
  });

  it('markers: no marker without a drawable reading, none above ground or below the log', () => {
    const s = buildScene(
      [
        bh('a', { gw: [{ type: 'strike', depth: 2 }, { type: 'rest', depth: 1.5, date: '2021-01-01' }] }),
        bh('b', { lng: 11.001, gw: [{ type: 'rest', depth: -0.5 }, { type: 'strike', depth: 9 }, { type: 'rest', depth: null, raw: 'dry' }] }),
        bh('c', { lng: 11.002 }),
      ],
      { mode: 'depth', exaggeration: 2, kind: 'set' },
    );
    expect(s.water.map((w) => [w.uid, w.type, w.position[2], w.filled, w.representative])).toEqual([
      ['a', 'strike', -4, false, false],
      ['a', 'rest', -3, true, true],
    ]);
    expect(s.counts.noGroundwater).toBe(2);
    expect(s.waterPoints).toBe(1);
  });

  it('a printed elevation wins over a depth when the ground level is stated', () => {
    const recs = [
      bh('a', { gl: 100, gw: [{ type: 'rest', depth: 1, elevation: 97.5 }] }),
      bh('b', { lng: 11.001, gl: 101, gw: [{ type: 'rest', depth: 2 }] }),
      bh('c', { lng: 11.002, gw: [{ type: 'rest', depth: 2.5, elevation: 50 }] }),
    ];
    const s = buildScene(recs, { mode: 'depth', exaggeration: 1, kind: 'set' });
    expect(s.water.map((w) => [w.uid, w.depth, w.elevation])).toEqual([
      ['a', 2.5, 97.5],
      ['b', 2, 99],
      ['c', 2.5, 50],
    ]);
    expect(s.water[0].position[2]).toBe(-2.5);
  });

  it('a line selection keeps the order, breaks at a borehole without a reading and drops single points', () => {
    const gw: Gw[] = [{ type: 'rest', depth: 1 }];
    const recs = [
      bh('a', { lng: 11.0, gw }),
      bh('b', { lng: 11.001, gw }),
      bh('c', { lng: 11.002 }),
      bh('d', { lng: 11.003, gw }),
      bh('e', { lng: 11.004, gw: [{ type: 'other', depth: 1 }] }),
      bh('f', { lng: 11.005, gw }),
      bh('g', { lng: 11.006, gw }),
    ];
    const s = buildScene(recs, { mode: 'depth', exaggeration: 1, kind: 'line' });
    const xOf = (uid: string) => s.boreholes.find((b) => b.uid === uid)!.x;
    expect(s.waterLine.map((run) => run.map((p) => p[0]))).toEqual([
      [xOf('a'), xOf('b')],
      [xOf('f'), xOf('g')],
    ]);
  });

  it('connectRuns never bridges a gap', () => {
    const p = (x: number): Vec3 => [x, 0, 0];
    expect(connectRuns([p(1), p(2), null, p(3), null, null, p(4), p(5), p(6)])).toEqual([
      [p(1), p(2)],
      [p(4), p(5), p(6)],
    ]);
    expect(connectRuns([null, p(1), null])).toEqual([]);
    expect(connectRuns([])).toEqual([]);
  });

  it('an area: the edges of the water surface, and one segment for two boreholes', () => {
    const gw: Gw[] = [{ type: 'rest', depth: 1 }];
    const square = [
      bh('a', { gw }),
      bh('b', { lng: 11 + dLon(50), gw }),
      bh('c', { lat: 48 + dLat(50), gw }),
      bh('d', { lat: 48 + dLat(50), lng: 11 + dLon(50), gw }),
    ];
    const s = buildScene(square, { mode: 'depth', exaggeration: 1, kind: 'area' });
    expect(s.waterSurface?.triangles).toHaveLength(2);
    expect(s.waterSurface?.boreholes).toBe(4);
    expect(s.waterLine).toHaveLength(5);
    expect(s.waterLine.every((l) => l.length === 2)).toBe(true);
    const two = buildScene(square.slice(0, 2), { mode: 'depth', exaggeration: 1, kind: 'set' });
    expect(two.waterSurface).toBeNull();
    expect(two.waterLine).toHaveLength(1);
    expect(two.waterLine[0]).toHaveLength(2);
  });
});

describe('tin', () => {
  it('fewer than 3 points and collinear points give null', () => {
    expect(tin([])).toBeNull();
    expect(tin([[0, 0, 0], [10, 0, 0]])).toBeNull();
    expect(tin([[0, 0, 0], [10, 0, 0], [20, 0, 1], [30, 0, 2]])).toBeNull();
    expect(tin([[0, 0, 0], [0, 0.005, 1], [10, 0, 0]])).toBeNull();
  });

  it('counts duplicates once (the first wins) and the boreholes that are corners', () => {
    const t = tin([[0, 0, 1], [0.004, 0, 9], [10, 0, 2], [0, 10, 3]])!;
    expect(t.triangles).toHaveLength(1);
    expect(t.edges).toHaveLength(3);
    expect(t.boreholes).toBe(3);
    expect(t.triangles[0].map((p) => p[2]).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('drops triangles with edges longer than max(3 × median nearest neighbour, 150 m)', () => {
    const cluster = (x0: number): Vec3[] => [[x0, 0, 0], [x0 + 20, 0, 0], [x0, 20, 0], [x0 + 20, 20, 0]];
    const t = tin([...cluster(0), ...cluster(1000)])!;
    expect(t.triangles).toHaveLength(4);
    for (const [a, b] of t.edges) expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(150);
    expect(t.boreholes).toBe(8);
    // Within 150 m nothing is dropped even when sparse.
    expect(tin([[0, 0, 0], [140, 0, 0], [0, 140, 0]])?.triangles).toHaveLength(1);
    // A sparse corner within reach of the 150 m floor is kept.
    expect(tin([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0], [140, 5, 0]])?.boreholes).toBe(5);
    // 3 × median nearest neighbour (100 m) = 300 m: the far point is cut off.
    expect(tin([[0, 0, 0], [100, 0, 0], [0, 100, 0], [100, 100, 0], [5000, 50, 0]])?.boreholes).toBe(4);
  });
});

describe('elevation mode', () => {
  const gw: Gw[] = [{ type: 'rest', depth: 1 }];
  const recs = [
    bh('a', { gl: 100, gw, rock: 4 }),
    bh('b', { gl: 102, lng: 11 + dLon(40), gw, rock: 4 }),
    bh('c', { gl: 101, lat: 48 + dLat(40), gw, rock: 4 }),
    bh('u', { lat: 48 + dLat(40), lng: 11 + dLon(40), gw, rock: 4 }),
  ];

  it('unplaced boreholes are ghosts at z = 0 with a ring and are left out of every line and surface', () => {
    const s = buildScene(recs, { mode: 'elevation', exaggeration: 2, kind: 'set' });
    const u = s.boreholes[3];
    expect(u).toMatchObject({ uid: 'u', placed: false, collarZ: 0, groundLevel: null });
    expect(s.segments.filter((g) => g.uid === 'u').every((g) => g.ghost && g.color[3] === 90)).toBe(true);
    expect(s.water.find((w) => w.uid === 'u')).toMatchObject({ ghost: true, representative: true });
    expect(s.counts.noGroundLevel).toBe(1);
    expect(s.ghostRings).toHaveLength(12);
    for (const arc of s.ghostRings) {
      expect(arc.length).toBeGreaterThanOrEqual(3);
      expect(arc.length).toBeLessThanOrEqual(4);
      for (const p of arc) expect(Math.hypot(p[0] - u.x, p[1] - u.y)).toBeCloseTo(1.8 * radiusOnScreen(s, s.extent.span / 400), 6);
    }
    const isU = (p: Vec3) => p[0] === u.x && p[1] === u.y;
    expect(s.waterLine.flat().some(isU)).toBe(false);
    for (const surf of [s.waterSurface, s.groundSurface, s.rockSurface]) {
      expect(surf?.boreholes).toBe(3);
      expect(surf!.triangles.flat().some(isU)).toBe(false);
    }
    expect(s.waterPoints).toBe(3);
    expect(s.groundSurface!.triangles[0].map((p) => p[2]).sort((a, b) => a - b)).toEqual([0, 2, 4]);
    // Rock head 4 m below each collar.
    expect(s.rockSurface!.triangles[0].map((p) => p[2]).sort((a, b) => a - b)).toEqual([-8, -6, -4]);
    const line = buildScene(recs, { mode: 'elevation', exaggeration: 2, kind: 'line' });
    expect(line.waterLine).toHaveLength(1);
    expect(line.waterLine[0]).toHaveLength(3);
  });

  it('depth mode has no ground surface; fewer than 2 ground levels falls back to depth mode', () => {
    expect(buildScene(recs, { mode: 'depth', exaggeration: 2, kind: 'set' }).groundSurface).toBeNull();
    const s = buildScene([bh('a', { gl: 100 }), bh('b', { lng: 11.001 })], { mode: 'elevation', exaggeration: 2, kind: 'set' });
    expect(s.mode).toBe('depth');
    expect(s.base).toBeNull();
    expect(s.boreholes.every((b) => b.placed && b.collarZ === 0)).toBe(true);
    expect(s.ghostRings).toEqual([]);
    expect(s.counts.noGroundLevel).toBe(0);
  });

  it('datum is null when the drawn boreholes state different ones', () => {
    const s = buildScene([bh('a', { gl: 100 }), bh('b', { gl: 101, lng: 11.001, datum: 'NHN' })], { mode: 'elevation', exaggeration: 1, kind: 'set' });
    expect(s.datum).toBeNull();
  });
});

describe('selection', () => {
  it('draws at most max boreholes and counts what was left out', () => {
    const many = Array.from({ length: 12 }, (_, i) => bh(`b${i}`, { lng: 11 + i * 0.001 }));
    const s = buildScene([...many, bh('x', { onMap: false }), bh('y', { lat: null })], { mode: 'depth', exaggeration: 1, kind: 'set', max: 10 });
    expect(s.boreholes.map((b) => b.uid)).toEqual(many.slice(0, 10).map((b) => b.uid));
    expect(s.counts).toEqual({ selected: 14, noPosition: 2, eligible: 12, drawn: 10, noGroundLevel: 0, noGroundwater: 10 });
    expect(MAX_BOREHOLES).toBe(300);
  });

  it('an empty selection gives an empty scene', () => {
    for (const recs of [[], [bh('x', { onMap: false })]]) {
      const s = buildScene(recs, { mode: 'elevation', exaggeration: 5, kind: 'area' });
      expect(s.frame).toBeNull();
      expect(s.bbox).toBeNull();
      expect(s.boreholes).toEqual([]);
      expect(s.segments).toEqual([]);
      expect(s.waterLine).toEqual([]);
      expect(s.waterSurface).toBeNull();
      expect(s.scale).toEqual({ rings: [], posts: [] });
      expect(s.extent.span).toBe(30);
      expect(fitView(s, { width: 800, height: 600 })).toBeNull();
    }
  });

  it('bbox and frame cover the drawn boreholes', () => {
    const s = buildScene([bh('a', { lat: 48, lng: 11 }), bh('b', { lat: 48.01, lng: 11.02 })], { mode: 'depth', exaggeration: 1, kind: 'set' });
    expect(s.bbox).toEqual([11, 48, 11.02, 48.01]);
    expect(s.frame!.lon0).toBeCloseTo(11.01, 9);
    expect(s.frame!.lat0).toBeCloseTo(48.005, 9);
    expect(s.boreholes[0].x).toBeCloseTo(-s.boreholes[1].x, 6);
  });
});

describe('scale helpers', () => {
  it('defaultExaggeration: a third of the site width, above 20 when the site needs it', () => {
    expect(defaultExaggeration(500, 20)).toBe(8);
    expect(defaultExaggeration(8000, 15)).toBe(160);
    expect(defaultExaggeration(1e7, 10)).toBe(EXAGGERATION_LIMIT);
    expect(defaultExaggeration(10, 30)).toBe(1);
    expect(defaultExaggeration(0, 10)).toBe(EXAGGERATION_FALLBACK);
    expect(defaultExaggeration(100, 0)).toBe(EXAGGERATION_FALLBACK);
    expect(defaultExaggeration(Number.NaN, 5)).toBe(EXAGGERATION_FALLBACK);
  });

  it('exaggerationMax: 20, or a tidy value of about twice the start', () => {
    expect(exaggerationMax(1)).toBe(20);
    expect(exaggerationMax(10)).toBe(20);
    expect(exaggerationMax(11)).toBe(50);
    expect(exaggerationMax(44)).toBe(100);
    expect(exaggerationMax(160)).toBe(500);
    expect(exaggerationMax(EXAGGERATION_LIMIT)).toBe(EXAGGERATION_LIMIT);
  });

  it('columnRadius: a column, not a disc; findable on a wide site', () => {
    expect(columnRadius(700, 140)).toBe(10);
    expect(columnRadius(8000, 140)).toBe(20);
    expect(columnRadius(1, 1)).toBe(0.5);
  });

  it('radiusOnScreen: slim between close neighbours, never under a few pixels, never over the scene radius', () => {
    const dense = { radius: 100, spacing: 10 };
    // Zoomed in: 0.4 of the spacing.
    expect(radiusOnScreen(dense, 0.5)).toBe(4);
    // From afar: 3 px at 6 m per pixel.
    expect(radiusOnScreen(dense, 6)).toBe(18);
    // Very far: the scene radius is the most.
    expect(radiusOnScreen(dense, 1000)).toBe(100);
    // Boreholes far apart, or a single one: the scene radius.
    expect(radiusOnScreen({ radius: 100, spacing: 2000 }, 0.5)).toBe(100);
    expect(radiusOnScreen({ radius: 100, spacing: null }, 0.5)).toBe(100);
    // Spots a hand apart still get a drawable column.
    expect(radiusOnScreen({ radius: 100, spacing: 0.6 }, 0.01)).toBe(0.5);
  });

  it('levelLabel: one metre unit, whatever the datum text carries', () => {
    expect(levelLabel('231', 'NN')).toBe('231 m NN');
    expect(levelLabel('231', 'NHN')).toBe('231 m NHN');
    expect(levelLabel('231', 'MSL')).toBe('231 m MSL');
    expect(levelLabel('231', 'm ü. NN')).toBe('231 m ü. NN');
    expect(levelLabel('231', 'mNN')).toBe('231 mNN');
    expect(levelLabel('231', 'm NN')).toBe('231 m NN');
    expect(levelLabel('231', 'moh')).toBe('231 moh');
    expect(levelLabel('12', null)).toBe('12 m');
    expect(levelLabel('12', '  ')).toBe('12 m');
  });

  it('neighbourSpacing: the close end of the nearest-neighbour distances, same spots apart', () => {
    expect(neighbourSpacing([])).toBeNull();
    expect(neighbourSpacing([{ x: 0, y: 0 }])).toBeNull();
    expect(neighbourSpacing([{ x: 0, y: 0 }, { x: 0.2, y: 0 }])).toBeNull();
    expect(neighbourSpacing([{ x: 0, y: 0 }, { x: 30, y: 40 }])).toBe(50);
    expect(neighbourSpacing([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 10, y: 0 }, { x: 110, y: 0 }])).toBeCloseTo(9.9, 6);
  });

  it('the scale frame: tidy levels from the top down to at or below the deepest bottom', () => {
    const d = buildScene([bh('a', { depth: 13, layers: [] }), bh('b', { depth: 6, lng: 11.001 })], { mode: 'depth', exaggeration: 2, kind: 'set' });
    expect(d.scale.rings.map((r) => r.value)).toEqual([0, 5, 10, 15]);
    expect(d.scale.rings.map((r) => r.z)).toEqual([0, -10, -20, -30]);
    const ring = d.scale.rings[1].path;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    const pad = Math.max(0.08 * d.extent.span, 2 * d.radius);
    expect(ring[0][0]).toBeCloseTo(d.extent.minX - pad, 9);
    expect(ring[2][1]).toBeCloseTo(d.extent.maxY + pad, 9);
    expect(d.scale.posts).toHaveLength(4);
    for (const [top, bottom] of d.scale.posts) {
      expect(top[2]).toBe(d.scale.rings[0].z);
      expect(bottom[2]).toBe(-30);
    }

    const e = buildScene([bh('a', { gl: 241.35, depth: 6 }), bh('b', { gl: 238, depth: 10, lng: 11.001, layers: [] })], { mode: 'elevation', exaggeration: 1, kind: 'set' });
    // Top 241.35, deepest bottom 228: step 5 (niceStep of 13.35 m), from the tidy level above the top.
    expect(e.scale.rings.map((r) => r.value)).toEqual([245, 240, 235, 230, 225]);
    expect(e.scale.rings[0].z).toBeCloseTo(245 - 238, 9);
    expect(e.scale.rings.at(-1)!.z).toBeCloseTo(225 - 238, 9);
  });
});

describe('ground tiles', () => {
  const bbox: [number, number, number, number] = [11, 48, 11 + dLon(400), 48 + dLat(300)];

  it('covers the padded box with at most maxTiles tiles at the highest such zoom', () => {
    for (const maxTiles of [36, 9, 4]) {
      const g = groundTiles(bbox, { maxTiles });
      expect(g.tiles.length).toBeLessThanOrEqual(maxTiles);
      expect(g.zoom).toBeLessThanOrEqual(19);
      // Padded by 60 % of 400 m = 240 m on every side.
      expect(bbox[0] - g.padded[0]).toBeCloseTo(dLon(240), 6);
      expect(g.padded[3] - bbox[3]).toBeCloseTo(dLat(240), 6);
      const west = Math.min(...g.tiles.map((t) => t.bounds[0]));
      const south = Math.min(...g.tiles.map((t) => t.bounds[1]));
      const east = Math.max(...g.tiles.map((t) => t.bounds[2]));
      const north = Math.max(...g.tiles.map((t) => t.bounds[3]));
      expect(west).toBeLessThanOrEqual(g.padded[0]);
      expect(south).toBeLessThanOrEqual(g.padded[1]);
      expect(east).toBeGreaterThanOrEqual(g.padded[2]);
      expect(north).toBeGreaterThanOrEqual(g.padded[3]);
      // One zoom more would need too many tiles.
      expect(groundTiles(bbox, { maxTiles, maxZoom: g.zoom + 1 }).zoom).toBe(g.zoom);
      expect(g.tiles.every((t) => t.z === g.zoom)).toBe(true);
    }
  });

  it('a single point is padded by about 150 m and maxZoom holds', () => {
    const g = groundTiles([11, 48, 11, 48], { maxZoom: 15 });
    expect(g.zoom).toBe(15);
    expect(g.padded[2] - 11).toBeCloseTo(dLon(150), 9);
    expect(g.tiles.length).toBeGreaterThanOrEqual(1);
  });

  it('standard XYZ tile maths and URL templates', () => {
    expect(tileBounds(0, 0, 0)[0]).toBe(-180);
    expect(tileBounds(0, 0, 0)[3]).toBeCloseTo(85.0511, 4);
    expect(tileBounds(1, 1, 0)).toEqual([0, 0, 180, expect.closeTo(85.0511, 4)]);
    expect(tileUrl('https://{s}.tile.example/{z}/{x}/{y}{r}.png', { z: 3, x: 4, y: 5 })).toBe('https://a.tile.example/3/4/5.png');
  });
});

describe('fitView', () => {
  it('centres on the frame origin and fits 2.2 × the span into the smaller side', () => {
    const s = buildScene([bh('a', { lng: 11 }), bh('b', { lng: 11 + dLon(1000) })], { mode: 'depth', exaggeration: 1, kind: 'set' });
    const v = fitView(s, { width: 1200, height: 600 })!;
    expect(v.longitude).toBe(s.frame!.lon0);
    expect(v.latitude).toBe(48);
    expect(v.pitch).toBe(58);
    expect(v.bearing).toBe(-24);
    const mpp = (40075016.686 * Math.cos((48 * Math.PI) / 180)) / (512 * 2 ** v.zoom);
    expect(mpp * 600).toBeCloseTo(2.2 * s.extent.span, 3);
    expect(s.extent.span).toBeCloseTo(1000, 6);
    // Clamped to [3, 20].
    const tiny = buildScene([bh('a')], { mode: 'depth', exaggeration: 1, kind: 'set' });
    expect(fitView(tiny, { width: 100000, height: 100000 })!.zoom).toBeLessThanOrEqual(20);
    expect(fitView({ frame: { lon0: 0, lat0: 0 }, extent: { ...tiny.extent, span: 1e8 } }, { width: 10, height: 10 })!.zoom).toBe(3);
  });
});
