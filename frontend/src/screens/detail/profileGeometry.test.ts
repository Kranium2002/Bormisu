import { describe, expect, it } from 'vitest';
import { makeBorehole, makeLayer } from '../../test/fixtures';
import {
  depthScale,
  depthTicks,
  firstRefusal,
  fitText,
  gwTriangle,
  layerLabel,
  notLogged,
  PROFILE_DEPTH_PX,
  PROFILE_TOP,
  refusalMarkerDepth,
  stratBlocks,
  textWidth,
  tickStep,
} from './profileGeometry';

describe('depthScale', () => {
  it('maps 0 m to the top and the final depth to the bottom of the axis', () => {
    const { y, depth } = depthScale({ finalDepth: 18, logBottom: 14.5 });
    expect(depth).toBe(18);
    expect(y(0)).toBe(PROFILE_TOP);
    expect(y(18)).toBe(PROFILE_TOP + PROFILE_DEPTH_PX);
    expect(y(9)).toBe(PROFILE_TOP + PROFILE_DEPTH_PX / 2);
  });

  it('covers the log bottom when it is deeper than the stated final depth', () => {
    expect(depthScale({ finalDepth: 10, logBottom: 12 }).depth).toBe(12);
  });

  it('never divides by zero for a borehole without depth', () => {
    const { y, s } = depthScale({ finalDepth: null, logBottom: 0 });
    expect(Number.isFinite(s)).toBe(true);
    expect(Number.isFinite(y(1))).toBe(true);
  });
});

describe('depth ticks', () => {
  it('ticks every 2 m, every 4 m beyond 22 m', () => {
    expect(tickStep(18)).toBe(2);
    expect(tickStep(22)).toBe(2);
    expect(tickStep(26.5)).toBe(4);
    expect(depthTicks(18)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(depthTicks(26.5)).toEqual([0, 4, 8, 12, 16, 20, 24]);
  });

  it('includes the final depth when it falls on a tick', () => {
    expect(depthTicks(10).at(-1)).toBe(10);
  });
});

describe('stratBlocks', () => {
  it('merges consecutive layers with the same stratigraphic name', () => {
    const layers = [
      makeLayer({ n: 1, from: 0, to: 0.4, stratigraphicName: 'Holocene' }),
      makeLayer({ n: 2, from: 0.4, to: 2.1, stratigraphicName: null }),
      makeLayer({ n: 3, from: 2.1, to: 4.8, stratigraphicName: 'Holocene' }),
      makeLayer({ n: 4, from: 4.8, to: 8.2, stratigraphicName: 'Holocene ' }),
      makeLayer({ n: 5, from: 8.2, to: 11.2, stratigraphicName: 'Pleistocene' }),
      makeLayer({ n: 6, from: 11.2, to: 12, stratigraphicName: '' }),
      makeLayer({ n: 7, from: 12, to: 13, stratigraphicName: null }),
    ];
    expect(stratBlocks(layers)).toEqual([
      { name: 'Holocene', from: 0, to: 0.4 },
      { name: null, from: 0.4, to: 2.1 },
      { name: 'Holocene', from: 2.1, to: 8.2 },
      { name: 'Pleistocene', from: 8.2, to: 11.2 },
      { name: null, from: 11.2, to: 13 },
    ]);
  });

  it('is empty without layers', () => {
    expect(stratBlocks([])).toEqual([]);
  });
});

describe('labels', () => {
  it('keeps a text that fits and cuts one that does not, with an ellipsis', () => {
    expect(fitText('qh', 30, 10)).toBe('qh');
    const cut = fitText('Upper Freshwater Molasse', 60, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, 10)).toBeLessThanOrEqual(60);
    expect(fitText('Holocene', 8, 10)).toBe('');
  });

  it('prefers the DIN notation when it fits, else the code, else nothing', () => {
    expect(layerLabel({ din: 'U', dinNotation: "U, t, s'" }, 120)).toBe("U, t, s'");
    expect(layerLabel({ din: 'U', dinNotation: "U, t, s'" }, 20)).toBe('U');
    expect(layerLabel({ din: 'U', dinNotation: null }, 120)).toBe('U');
    expect(layerLabel({ din: null, dinNotation: null }, 120)).toBe('');
  });
});

describe('notLogged', () => {
  it('flags a log that ends above the final depth', () => {
    const b = makeBorehole({ finalDepth: 18, logBottom: 14.5 });
    expect(notLogged(b)).toEqual({ from: 14.5, to: 18, label: 'log ends 14,50 ≠ ET 18,00' });
  });

  it('is null when the log reaches the final depth, the final depth is unknown or there are no layers', () => {
    expect(notLogged(makeBorehole())).toBeNull();
    expect(notLogged(makeBorehole({ finalDepth: null }))).toBeNull();
    expect(notLogged(makeBorehole({ layers: [], logBottom: 0 }))).toBeNull();
  });
});

describe('markers', () => {
  it('draws the groundwater triangle tip just above the level line', () => {
    expect(gwTriangle(100)).toBe('M90 89 L102 89 L96 99 Z');
  });

  it('finds the first SPT refusal from the top', () => {
    const layers = [
      makeLayer({ n: 1, from: 0, to: 2, spt: { raw: '3,4,5 = 9', depth: 1, refusal: false, increments: [3, 4, 5], n: 9 } }),
      makeLayer({ n: 2, from: 2, to: 5, spt: { raw: '50/30', depth: 3.5, refusal: true, blows: 50, penetrationCm: 30 } }),
      makeLayer({ n: 3, from: 5, to: 8, spt: { raw: '50/10', depth: 6.5, refusal: true, blows: 50, penetrationCm: 10 } }),
    ];
    const r = firstRefusal(layers);
    expect(r?.layer.n).toBe(2);
    expect(r?.depth).toBe(3.5);
    expect(r?.raw).toBe('50/30');
    expect(firstRefusal(layers.slice(0, 1))).toBeNull();
  });

  it('keeps a refusal without a stated depth null, and places its marker mid-layer as unstated', () => {
    const layer = makeLayer({ n: 4, from: 6, to: 9, spt: { raw: '50/5', depth: null, refusal: true, blows: 50, penetrationCm: 5 } });
    const r = firstRefusal([layer]);
    expect(r?.depth).toBeNull();
    expect(refusalMarkerDepth(r!)).toEqual({ at: 7.5, stated: false });
    expect(refusalMarkerDepth({ layer, depth: 6.4, raw: '50/5' })).toEqual({ at: 6.4, stated: true });
  });
});
