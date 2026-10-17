import { expect, it } from 'vitest';
import { formatTestValue, testResultFromApi } from './testResults';

it('keeps only the stated numeric values, in field order', () => {
  const t = testResultFromApi({ sample_name: 'P1', sample_type: 'soil', sample_depth_m: 3, ucs_mpa: null, liquid_limit_pct: 38, water_content_pct: 21.5 });
  expect(t).toMatchObject({ sampleName: 'P1', sampleType: 'soil', depth: 3 });
  expect(t.values.map((v) => v.key)).toEqual(['water_content_pct', 'liquid_limit_pct']);
});

it('leaves out what the source does not state', () => {
  expect(testResultFromApi({ sample_type: 'clay', sample_depth_m: 'x' })).toEqual({ sampleName: null, sampleType: null, depth: null, values: [] });
});

it('formats tiny values in scientific notation', () => {
  expect(formatTestValue({ key: 'k', label: 'k', value: 0.00000042, unit: 'm/s' })).toBe('4.2e-7 m/s');
  expect(formatTestValue({ key: 'w', label: 'w', value: 21.5, unit: '%' })).toBe('21.5 %');
});
