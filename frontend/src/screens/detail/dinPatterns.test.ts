import { describe, expect, it } from 'vitest';
import { dinPatternId, patternDefs } from './dinPatterns';

const layer = (din: string, lithology = '', pattern = 'sand' as const) => ({ din, lithology, pattern });

describe('dinPatternId', () => {
  it('uses the main component of the DIN code, case-sensitive', () => {
    expect(dinPatternId(layer('T, u'))).toBe('din-soil_T');
    expect(dinPatternId(layer('mG'))).toBe('din-soil_mG');
    expect(dinPatternId(layer('Mg'))).toBe('din-geological_Mg');
    expect(dinPatternId(layer('Kst'))).toBe('din-rock_Kst');
  });
  it('falls back to the lithology guess, and to nothing when the source names nothing', () => {
    expect(dinPatternId({ din: 'Clay', lithology: 'silty clay', pattern: 'clay' })).toBe('din-soil_T');
    expect(dinPatternId(layer(''))).toBeNull();
  });
});

it('patternDefs embeds each used pattern once', () => {
  const defs = patternDefs(['din-soil_T', 'din-soil_T', null]);
  expect(defs.match(/<pattern /g)).toHaveLength(1);
  expect(defs).toContain('id="din-soil_T"');
});
