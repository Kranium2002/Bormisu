import { describe, expect, it } from 'vitest';
import { layerFill, MISSING_PATTERN, patternDefs, propertySymbols } from './dinPatterns';

const layer = (din: string, lithology = '', pattern = 'sand' as const) => ({ din, lithology, pattern });
const ids = (din: string) => layerFill(layer(din)).map((f) => f.patternId);

describe('layerFill', () => {
  it('draws the main component, case-sensitive', () => {
    expect(ids('T')).toEqual(['din-soil_T']);
    expect(ids('mG')).toEqual(['din-soil_mG']);
    expect(ids('Mg')).toEqual(['din-geological_Mg']);
  });
  it('adds the first secondary component as a symbol over the right half', () => {
    expect(layerFill(layer('T, u'))).toEqual([
      { x0: 0, x1: 1, fill: 'url(#din-soil_T)', patternId: 'din-soil_T' },
      { x0: 0.5, x1: 1, fill: 'url(#din-sym-soil_U)', patternId: 'din-sym-soil_U' },
    ]);
    expect(ids("H, fs, u'")).toEqual(['din-soil_H', 'din-sym-soil_fS']);
    expect(ids('G, s*')).toEqual(['din-soil_G', 'din-sym-soil_S']);
    expect(ids('T, k')).toEqual(['din-soil_T']); // k has no symbol in Table 1: main only
  });
  it('splits two equal parts into colour halves with both symbols over the full width', () => {
    const f = layerFill(layer('S/G'));
    expect(f.map((p) => [p.x0, p.x1, p.fill])).toEqual([
      [0, 0.5, '#C6542F'], [0.5, 1, '#DBAB06'], [0, 1, 'url(#din-sym-soil_S)'], [0, 1, 'url(#din-sym-soil_G)'],
    ]);
  });
  it('marks an unknown code red, guesses only without a code, and draws nothing when nothing is named', () => {
    expect(ids('Clay')).toEqual([MISSING_PATTERN]);
    expect(ids('')).toEqual([]);
    expect(layerFill({ din: '', lithology: 'silty clay', pattern: 'clay' }).map((f) => f.patternId)).toEqual(['din-soil_T']);
  });
});

describe('propertySymbols', () => {
  it('matches consistency / density in English or German, never guesses', () => {
    expect(propertySymbols({ consistencyDensity: 'steif' }).map((p) => p.key)).toEqual(['consistency_firm']);
    expect(propertySymbols({ consistencyDensity: 'Medium Dense' }).map((p) => p.key)).toEqual(['density_medium_dense']);
    expect(propertySymbols({ consistencyDensity: 'soft to firm' })).toEqual([]);
  });
  it('draws wet, consistency, weathering and jointing left to right; weathering has a frame', () => {
    const p = propertySymbols({ wet: true, weathering: 'w2_3', jointing: 'jointed' });
    expect(p.map((s) => s.key)).toEqual(['moisture_wet', 'weathering_w2_3', 'jointing_jointed']);
    expect(p[0].markup).toBeTruthy();
    expect(p[1].frame).toBeGreaterThan(0);
  });
});

it('patternDefs embeds each used pattern once', () => {
  const defs = patternDefs(['din-soil_T', 'din-soil_T', 'din-sym-soil_U', null]);
  expect(defs.match(/<pattern /g)).toHaveLength(2);
  expect(defs).toContain('id="din-sym-soil_U"');
});
