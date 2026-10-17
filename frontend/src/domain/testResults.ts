import type { TestResult, TestValue } from './types';

/** The Herrenknecht lab test fields (API contract §5.5): API name, label and unit, in display order. */
export const TEST_FIELDS: readonly { key: string; label: string; unit: string }[] = [
  { key: 'water_content_pct', label: 'Water content', unit: '%' },
  { key: 'density_kn_m3', label: 'Unit weight', unit: 'kN/m³' },
  { key: 'ucs_mpa', label: 'UCS', unit: 'MPa' },
  { key: 'tensile_strength_mpa', label: 'Tensile strength', unit: 'MPa' },
  { key: 'cai_cerchar_abrasivity', label: 'CAI', unit: '' },
  { key: 'rmr', label: 'RMR', unit: '' },
  { key: 'q_value', label: 'Q', unit: '' },
  { key: 'gsi', label: 'GSI', unit: '' },
  { key: 'friction_angle_deg', label: 'Friction angle', unit: '°' },
  { key: 'cohesion_kpa', label: 'Cohesion', unit: 'kPa' },
  { key: 'fines_pct', label: 'Fines', unit: '%' },
  { key: 'liquid_limit_pct', label: 'Liquid limit', unit: '%' },
  { key: 'plastic_limit_pct', label: 'Plastic limit', unit: '%' },
  { key: 'plasticity_index_pct', label: 'Plasticity index', unit: '%' },
  { key: 'consistency_index', label: 'Consistency index', unit: '' },
  { key: 'hydraulic_conductivity_m_s', label: 'Hydraulic conductivity', unit: 'm/s' },
  { key: 'e_modulus_mpa', label: 'E-modulus', unit: 'MPa' },
  { key: 'poissons_ratio', label: "Poisson's ratio", unit: '' },
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
