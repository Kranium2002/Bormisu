/** The profile draws only measurements the source states (codex finding c22). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import { applyValuePatch } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { makeBorehole, makeLayer, makeValue } from '../../test/fixtures';
import { ProfileColumn } from './ProfileColumn';
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
    expect(html).toContain('rock head 2,50');
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
    expect(html).not.toContain('rock head 2,50');
    expect(html).not.toContain('SPT refusal');
  });

  it('says "ET not stated" when the final depth is unknown', () => {
    expect(render({ ...borehole(), finalDepth: null })).toContain('ET not stated');
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
