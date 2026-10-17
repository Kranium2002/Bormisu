/** The profile draws only measurements the source states (codex finding c22). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import { applyValuePatch } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { makeBorehole, makeLayer, makeValue } from '../../test/fixtures';
import { ProfileColumn, ProfileLegend } from './ProfileColumn';
import { isStated } from './profileGeometry';

const refusal = { raw: '50/30', depth: 4, refusal: true, blows: 50, penetrationCm: 30 };

function borehole(): Borehole {
  const b = makeBorehole({
    rockHead: 2.5,
    layers: [makeLayer({ n: 1, from: 0, to: 2.5 }), makeLayer({ n: 2, from: 2.5, to: 6, spt: refusal })],
  });
  return {
    ...b,
    values: [
      ...b.values,
      makeValue({ key: K.rockHead, field: 'RockHead', value: '2.50', unit: 'm' }),
      makeValue({ key: K.spt(2), field: 'SPT', group: 'layer', layer: 2, raw: '50/30', value: 'refusal · 50 blows / 30 cm', spt: refusal, refusal: true }),
    ],
  };
}

const render = (b: Borehole) =>
  renderToStaticMarkup(<ProfileColumn borehole={b} selectedLayer={1} onSelectLayer={() => undefined} onOpenSource={() => undefined} />);

describe('ProfileColumn', () => {
  it('draws groundwater, rock head and the SPT refusal marker the source states', () => {
    const html = render(borehole());
    expect(html).toContain('GW strike 1.80 m: show source');
    expect(html).toContain('rock head 2.50');
    expect(html).toContain('SPT refusal 50/30 at 4.00 m: show source');
  });

  // Regression (c22): a reading marked "not in source" was hidden in the table but still drawn.
  it('leaves out measurements the reviewer marked "not in source" or "illegible"', () => {
    let b = borehole();
    b = applyValuePatch(b, K.gwStrike, { state: 'not in source', status: 'approved' });
    b = applyValuePatch(b, K.rockHead, { state: 'illegible', status: 'approved' });
    b = applyValuePatch(b, K.spt(2), { state: 'not in source', status: 'approved' });
    const html = render(b);
    expect(html).not.toContain('GW strike');
    expect(html).not.toContain('rock head 2.50');
    expect(html).not.toContain('SPT refusal');
  });

  it('writes "no pattern assigned" on a layer whose DIN code has no pattern', () => {
    const b = makeBorehole({ layers: [makeLayer({ n: 1, from: 0, to: 2, din: 'XYZ' }), makeLayer({ n: 2, from: 2, to: 4, din: 'T' })] });
    expect(render(b).match(/no pattern assigned/g)).toHaveLength(1);
  });

  it('says "ET not stated" when the final depth is unknown', () => {
    expect(render({ ...borehole(), finalDepth: null })).toContain('ET not stated');
  });

  // X01: the profile used decimal commas while the rest of the screen uses points.
  it('writes depths with a decimal point', () => {
    const html = render({ ...borehole(), finalDepth: 18, logBottom: 6 });
    expect(html).toContain('ET 18.00 m');
    expect(html).toContain('final depth 18.00 m');
    expect(html).toContain('log ends 6.00 ≠ ET 18.00');
    // DIN pattern path data ("C7.3,164.4") isn't a depth.
    expect(html.replace(/<pattern[\s\S]*?<\/pattern>/g, '')).not.toMatch(/\d,\d\d/);
  });
});

// X07: the legend explained symbols the profile didn't draw.
describe('ProfileLegend', () => {
  const legend = (b: Borehole) => renderToStaticMarkup(<ProfileLegend borehole={b} />);

  it('lists the symbols the profile draws', () => {
    const html = legend(borehole());
    expect(html).toContain('GW strike');
    expect(html).toContain('SPT refusal: click for source');
    expect(html).not.toContain('GW rest level');
  });

  it('leaves out the SPT refusal for a borehole without one', () => {
    const b = borehole();
    const html = legend({ ...b, layers: b.layers.map((l) => ({ ...l, spt: undefined })) });
    expect(html).toContain('GW strike');
    expect(html).not.toContain('SPT refusal');
  });

  it('names the hollow triangle after the readings it stands for', () => {
    const b = borehole();
    const groundwater = [...b.groundwater, { type: 'rest' as const, depth: 1.2, key: K.gwRest }];
    expect(legend({ ...b, groundwater })).toContain('GW rest level');
  });

  it('is empty when the profile draws no symbol', () => {
    const b = applyValuePatch(borehole(), K.spt(2), { state: 'not in source', status: 'approved' });
    expect(legend({ ...b, groundwater: [] })).toBe('');
  });
});

describe('isStated', () => {
  it('is true without a value, and for a value in state ok only', () => {
    const b = borehole();
    expect(isStated(b, 'no-such-key')).toBe(true);
    expect(isStated(b, K.gwStrike)).toBe(true);
    expect(isStated(applyValuePatch(b, K.gwStrike, { state: 'illegible' }), K.gwStrike)).toBe(false);
  });
});
