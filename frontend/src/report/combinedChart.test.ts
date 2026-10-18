import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { Borehole } from '../domain/types';
import { makeBorehole, makeLayer, makeValue } from '../test/fixtures';
import { canAlignByElevation, CHART_MAX, chainageLabel, combinedChart, COL_W, DRAW_H, logDepth, niceStep, PITCH, spreadAlong } from './combinedChart';

function bh(uid: string, o: { gl?: number; depth?: number; layers?: Borehole['layers']; gw?: number | null } = {}): Borehole {
  const b = makeBorehole({ uid, id: uid.toUpperCase(), finalDepth: o.depth ?? 6, logBottom: o.depth ?? 6 });
  return {
    ...b,
    layers: o.layers ?? b.layers,
    groundwater: o.gw === undefined ? b.groundwater : o.gw === null ? [] : [{ ...b.groundwater[0], depth: o.gw }],
    meta: o.gl != null ? { ...b.meta, elevationDatum: 'NN' } : b.meta,
    values: o.gl != null ? [...b.values, makeValue({ key: K.elevation, value: String(o.gl), unit: 'm' })] : b.values,
  };
}

describe('combined chart', () => {
  it('depth mode: every column starts at the axis top, on one scale', () => {
    const c = combinedChart([bh('a', { depth: 6 }), bh('b', { depth: 12, layers: [makeLayer({ n: 1, from: 0, to: 12, din: 'S' })] })], { mode: 'depth' });
    expect(c.columns.map((col) => col.groundY)).toEqual([c.drawTop, c.drawTop]);
    // One scale: the deeper hole reaches twice as far down.
    expect(c.columns[1].bottomY - c.drawTop).toBeCloseTo(2 * (c.columns[0].bottomY - c.drawTop), 5);
    expect(c.ticks[0].label).toBe('0');
    expect(c.axisTitle).toBe('Depth below ground (m)');
    expect(c.columns[0].layers[1]).toMatchObject({ din: 'T', fill: 'url(#din-soil_T)' });
  });

  it('elevation mode: columns hang from their ground level; boreholes without one are named and left out', () => {
    const recs = [bh('a', { gl: 150 }), bh('b', { gl: 144 }), bh('c')];
    expect(canAlignByElevation(recs)).toBe(true);
    const c = combinedChart(recs, { mode: 'elevation' });
    expect(c.columns.map((col) => col.uid)).toEqual(['a', 'b']);
    expect(c.withoutGroundLevel).toEqual(['C']);
    const [a, b] = c.columns;
    const pxPerM = (b.groundY - a.groundY) / 6;
    expect(pxPerM).toBeGreaterThan(0);
    expect(b.bottomY - b.groundY).toBeCloseTo(6 * pxPerM, 5);
    expect(c.datum).toBe('NN');
    expect(canAlignByElevation([bh('a', { gl: 1 }), bh('b')])).toBe(false);
  });

  it('draws at most CHART_MAX columns and says how many there were', () => {
    const many = Array.from({ length: 55 }, (_, i) => bh(`b${i}`));
    const c = combinedChart(many, { mode: 'depth' });
    expect(c.shown).toBe(CHART_MAX);
    expect(c.eligible).toBe(55);
    expect(c.columns).toHaveLength(CHART_MAX);
    expect(c.width).toBeGreaterThanOrEqual(CHART_MAX * PITCH);
  });

  it('a planned line places columns at their chainage, pushed apart just enough, inside the axis', () => {
    const recs = [bh('a'), bh('b'), bh('c'), bh('d')];
    const chainages = new Map([
      ['a', 0],
      ['b', 5],
      ['c', 6],
      ['d', 1000],
    ]);
    const c = combinedChart(recs, { mode: 'depth', chainages, lineLengthM: 1000 });
    const xs = c.columns.map((col) => col.cx);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(PITCH - 1e-9);
    expect(c.columns[0].anchorX).toBe(c.chainageAxis!.x0);
    expect(c.columns[3].anchorX).toBe(c.chainageAxis!.x1);
    expect(c.chainageAxis!.ticks.map((t) => t.label)).toEqual(['0 m', '200 m', '400 m', '600 m', '800 m', '1 km']);
    expect(c.columns.every((col) => col.x >= c.left && col.x + COL_W <= c.width)).toBe(true);
  });

  it('spreadAlong keeps the order and the bounds when crowded at the end', () => {
    expect(spreadAlong([100, 100, 100], 0, 100, 10)).toEqual([80, 90, 100]);
    expect(spreadAlong([0, 50, 51], 0, 200, 10)).toEqual([0, 50, 60]);
  });

  it('no invented codes: a layer without a code is grey and the legend says so; groundwater outside the log is not drawn', () => {
    const layers = [makeLayer({ n: 1, from: 0, to: 3, din: null, dinNotation: null }), makeLayer({ n: 2, from: 3, to: 6, din: 'T', dinNotation: 'T' })];
    const c = combinedChart([bh('a', { gw: -1.85, layers }), bh('b', { gw: 2, layers })], { mode: 'depth' });
    expect(c.uncoded).toBe(true);
    expect(c.columns[0].layers[0].fill).toBe('#E0E0E0');
    expect(c.legend.map((l) => l.code)).toEqual(['T']);
    expect(c.columns[0].groundwaterY).toBeNull();
    // 6 m deep on a 6 m axis: 2 m is a third of the drawing.
    expect(c.columns[1].groundwaterY).toBeCloseTo(c.drawTop + DRAW_H / 3, 5);
    expect(combinedChart([bh('c', { layers: [layers[1]] })], { mode: 'depth' }).uncoded).toBe(false);
  });

  it('helpers: log depth, tidy steps and chainage labels', () => {
    expect(logDepth({ finalDepth: null, logBottom: 0, layers: [makeLayer({ n: 1, from: 0, to: 4.2 })] })).toBe(4.2);
    expect(niceStep(1000)).toBe(200);
    expect(niceStep(37)).toBe(10);
    expect(chainageLabel(1250)).toBe('1.25 km');
    expect(chainageLabel(400)).toBe('400 m');
  });
});
