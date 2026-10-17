import { K } from './keys';
import type { Borehole, ExtractedValue, TestResult, TestValue } from './types';

/**
 * The Herrenknecht lab test fields (API contract §5.5): API name, label, unit and the Test Results column
 * of the target format, in display order.
 */
export const TEST_FIELDS: readonly { key: string; label: string; unit: string; target: string }[] = [
  { key: 'water_content_pct', label: 'Water content', unit: '%', target: 'Watercontent' },
  { key: 'density_kn_m3', label: 'Unit weight', unit: 'kN/m³', target: 'Unitweight' },
  { key: 'ucs_mpa', label: 'UCS', unit: 'MPa', target: 'UCS' },
  { key: 'tensile_strength_mpa', label: 'Tensile strength', unit: 'MPa', target: 'Tensile strength' },
  { key: 'cai_cerchar_abrasivity', label: 'CAI', unit: '', target: 'CAI' },
  { key: 'rmr', label: 'RMR', unit: '', target: 'RMR' },
  { key: 'q_value', label: 'Q', unit: '', target: 'Q' },
  { key: 'gsi', label: 'GSI', unit: '', target: 'GSI' },
  { key: 'friction_angle_deg', label: 'Friction angle', unit: '°', target: 'FrictionAngle' },
  { key: 'cohesion_kpa', label: 'Cohesion', unit: 'kPa', target: 'Cohesion' },
  { key: 'fines_pct', label: 'Fines', unit: '%', target: 'Grainsize-fines' },
  { key: 'liquid_limit_pct', label: 'Liquid limit', unit: '%', target: 'LiquidLimit' },
  { key: 'plastic_limit_pct', label: 'Plastic limit', unit: '%', target: 'PlasticityLimit' },
  { key: 'plasticity_index_pct', label: 'Plasticity index', unit: '%', target: 'PlasticityIndex' },
  { key: 'consistency_index', label: 'Consistency index', unit: '', target: 'ConsistencyIndex' },
  { key: 'hydraulic_conductivity_m_s', label: 'Hydraulic conductivity', unit: 'm/s', target: 'HydraulicCoefficient' },
  { key: 'e_modulus_mpa', label: 'E-modulus', unit: 'MPa', target: 'E-Modulus' },
  { key: 'poissons_ratio', label: "Poisson's ratio", unit: '', target: 'PoissonsRatio' },
];

/** An API test_results[] entry → the frontend's TestResult; only numeric values the source states. */
export function testResultFromApi(raw: Record<string, unknown>): TestResult {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const values: TestValue[] = [];
  for (const f of TEST_FIELDS) {
    const v = num(raw[f.key]);
    if (v != null) values.push({ ...f, value: v });
  }
  const type = raw.sample_type;
  return {
    sampleName: typeof raw.sample_name === 'string' && raw.sample_name.trim() ? raw.sample_name : null,
    sampleType: type === 'soil' || type === 'water' ? type : null,
    depth: num(raw.sample_depth_m),
    values,
  };
}

/** "21.5 %", "4.2e-7 m/s": small and large numbers in scientific notation, the rest as printed. */
export function formatTestValue(v: TestValue): string {
  const abs = Math.abs(v.value);
  const n = abs !== 0 && (abs < 0.001 || abs >= 1e6) ? v.value.toExponential(1) : String(v.value);
  return v.unit ? `${n} ${v.unit}` : n;
}

/** The sample depth is a value too (key test_results[i].sample_depth_m). */
export const SAMPLE_DEPTH = 'sample_depth_m';

/**
 * Reviewable values of a borehole's test results (group 'test'): the sample depth and every lab value, keyed
 * by their API path, so the document view, the dots and the Review page work for them like for any value.
 * For data without provenance (the fictional sample): the borehole's log page, no box.
 */
export function testValues(b: Pick<Borehole, 'testResults' | 'primaryPage'>, confidence = 0.92): ExtractedValue[] {
  const value = (i: number, key: string, field: string, label: string, v: number, unit: string): ExtractedValue => ({
    key: K.test(i, key), field, label, group: 'test', test: i, raw: String(v), value: String(v), unit,
    page: b.primaryPage, box: null, method: 'Read', confidence, status: 'unreviewed', state: 'ok', aiValue: String(v),
  });
  return (b.testResults ?? []).flatMap((t, i) => {
    const name = t.sampleName ?? `Sample ${i + 1}`;
    return [
      ...(t.depth != null ? [value(i, SAMPLE_DEPTH, 'SampleDepth', `${name} · depth`, t.depth, 'm')] : []),
      ...t.values.map((v) => value(i, v.key, TEST_FIELDS.find((f) => f.key === v.key)?.target ?? v.key, `${name} · ${v.label}`, v.value, v.unit)),
    ];
  });
}

const TEST_KEY = /^test_results\[(\d+)\]\.(\w+)$/;

/** A corrected test value back into the borehole's test results (number only; other text keeps the last number). */
export function syncTestValue(b: Borehole, key: string, num: number | null): Borehole | null {
  const m = TEST_KEY.exec(key);
  if (!m) return null;
  if (num == null) return b;
  const i = Number(m[1]);
  const field = m[2];
  const testResults = (b.testResults ?? []).map((t, j) => {
    if (j !== i) return t;
    if (field === SAMPLE_DEPTH) return { ...t, depth: num };
    const f = TEST_FIELDS.find((x) => x.key === field);
    const values = t.values.some((v) => v.key === field)
      ? t.values.map((v) => (v.key === field ? { ...v, value: num } : v))
      : [...t.values, { key: field, label: f?.label ?? field, unit: f?.unit ?? '', value: num }];
    return { ...t, values };
  });
  return { ...b, testResults };
}
