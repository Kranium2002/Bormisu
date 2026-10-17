import { metres } from './format';
import { TEST_FIELDS } from './testResults';
import type { Borehole, FieldValue, Layer } from './types';

/**
 * Every column of the data model (README_data.md) as something the LIST can show for one borehole,
 * grouped by its table. Borehole columns show their value; layer, test-result, groundwater and joint
 * columns summarise the borehole's rows: codes joined ("T, u · G, s"), numbers as a range ("12–28 %"),
 * yes / no as a count ("2 of 6"). "–" = not stated in the source, never a guess.
 */
export type FieldGroup = 'Borehole' | 'Layers' | 'Test results' | 'Groundwater' | 'Joints' | 'Document';

export interface FieldDef {
  /** `<table>.<README column>`, e.g. "boreholes.client". */
  key: string;
  group: FieldGroup;
  /** README column name, e.g. "client", shown as the column's tooltip. */
  column: string;
  label: string;
  /** Narrowest column width in px. */
  min: number;
  /** Numbers and codes in the mono face. */
  mono?: boolean;
  text(b: Borehole): string;
  /** Amber when the value needs a look (an inferred CRS). */
  warn?(b: Borehole): boolean;
}

const NONE = '–';
const str = (v: FieldValue | undefined) => (v == null || v === '' ? NONE : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const m = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? metres(v) : NONE);
const joined = (vals: (FieldValue | undefined)[]) => [...new Set(vals.filter((v) => v != null && v !== '').map(String))].join(' · ') || NONE;
const fmt = (n: number) => String(Math.round(n * 100) / 100);
/** "12–28 %", "3.10 m" (one value), "–" (none). */
function range(vals: (number | null | undefined)[], unit = ''): string {
  const ns = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (!ns.length) return NONE;
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  const body = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  return unit ? `${body} ${unit}` : body;
}
const count = (n: number, of: number) => (of ? `${n} of ${of}` : NONE);
const field = (b: Borehole, column: string) => b.fields?.[column];
const layerField = (l: Layer, column: string) => l.fields?.[column];

/** A README `boreholes` column read from `Borehole.fields`. */
const bh = (column: string, label: string, min = 140, mono = false): FieldDef =>
  ({ key: `boreholes.${column}`, group: 'Borehole', column, label, min, mono, text: (b) => str(field(b, column)) });
const bhM = (column: string, label: string): FieldDef =>
  ({ key: `boreholes.${column}`, group: 'Borehole', column, label, min: 110, mono: true, text: (b) => m(field(b, column) as number | null) });

const BOREHOLE: FieldDef[] = [
  bh('location_name', 'LOCATION', 160),
  bh('start_date', 'START DATE', 110, true),
  bh('end_date', 'END DATE', 110, true),
  bh('project_id', 'PROJECT ID', 110, true),
  bh('country', 'COUNTRY', 120),
  bh('client', 'CLIENT', 160),
  bh('drilling_contractor', 'DRILLING CONTRACTOR', 170),
  bh('driller_name', 'DRILLER', 130),
  bhM('surface_elevation', 'SURFACE ELEVATION'),
  { key: 'boreholes.x-coordinate', group: 'Borehole', column: 'x-coordinate', label: 'LONGITUDE', min: 110, mono: true, text: (b) => (b.lng == null ? NONE : b.lng.toFixed(4)) },
  { key: 'boreholes.y-coordinate', group: 'Borehole', column: 'y-coordinate', label: 'LATITUDE', min: 110, mono: true, text: (b) => (b.lat == null ? NONE : b.lat.toFixed(4)) },
  bhM('location_uncertainty', 'LOCATION UNCERTAINTY'),
  {
    key: 'boreholes.coordinate_system', group: 'Borehole', column: 'coordinate_system', label: 'CRS', min: 170,
    text: (b) => (b.crs.name ? `${b.crs.name}${b.crs.code ? ` (${b.crs.code})` : ''}` : NONE), warn: (b) => b.crs.status === 'inferred',
  },
  bh('local_x', 'LOCAL X', 120, true),
  bh('local_y', 'LOCAL Y', 120, true),
  { key: 'boreholes.crs_status', group: 'Borehole', column: 'crs_status', label: 'CRS STATUS', min: 110, text: (b) => b.crs.status, warn: (b) => b.crs.status === 'inferred' || b.crs.status === 'unknown' },
  { key: 'boreholes.borehole_depth', group: 'Borehole', column: 'borehole_depth', label: 'FINAL DEPTH', min: 110, mono: true, text: (b) => m(b.finalDepth) },
  bhM('borehole_length', 'BOREHOLE LENGTH'),
  bh('casing_info', 'CASING', 160),
  bhM('groundwaterlevel', 'GROUNDWATER LEVEL'),
  bh('tbm_assessment', 'TBM ASSESSMENT', 160),
  bh('notes', 'NOTES', 180),
  bh('created_at', 'CREATED', 160, true),
  bh('updated_at', 'UPDATED', 160, true),
];

const ly = (column: string, label: string, min: number, text: (ls: Layer[]) => string, mono = false): FieldDef =>
  ({ key: `layers.${column}`, group: 'Layers', column, label, min, mono, text: (b) => text(b.layers) });
const LAYERS: FieldDef[] = [
  ly('position', 'LAYERS', 80, (ls) => String(ls.length), true),
  ly('depth_to', 'LOGGED DEPTH', 120, (ls) => (ls.length ? `${fmt(ls[0].from)}–${fmt(ls[ls.length - 1].to)} m` : NONE), true),
  ly('original_description', 'DESCRIPTION (PRINTED)', 260, (ls) => joined(ls.map((l) => l.lithologyAsPrinted))),
  ly('english_lithology', 'LITHOLOGY', 240, (ls) => joined(ls.map((l) => l.lithology))),
  ly('din_code', 'DIN 4023 CODES', 160, (ls) => joined(ls.map((l) => l.din)), true),
  ly('uscs_group', 'USCS GROUPS', 120, (ls) => joined(ls.map((l) => layerField(l, 'uscs_group'))), true),
  ly('strength', 'STRENGTH', 160, (ls) => joined(ls.map((l) => l.props?.consistencyDensity))),
  ly('weathering', 'WEATHERING', 110, (ls) => joined(ls.map((l) => l.props?.weathering)), true),
  ly('jointing', 'JOINTING', 130, (ls) => joined(ls.map((l) => l.props?.jointing))),
  ly('wet', 'WET LAYERS', 100, (ls) => count(ls.filter((l) => l.props?.wet).length, ls.length)),
  ly('stratigraphic_name', 'FORMATION', 180, (ls) => joined(ls.map((l) => layerField(l, 'stratigraphic_name')))),
  ly('geologic_age', 'GEOLOGIC AGE', 150, (ls) => joined(ls.map((l) => layerField(l, 'geologic_age')))),
  ly('core', 'CORED LAYERS', 110, (ls) => count(ls.filter((l) => l.props?.core).length, ls.length)),
  ly('total_core_recovery', 'TCR', 100, (ls) => range(ls.map((l) => l.tcr), '%'), true),
  ly('rqd', 'RQD', 100, (ls) => range(ls.map((l) => l.rqd), '%'), true),
  ly('spt_n_value', 'SPT N', 90, (ls) => range(ls.map((l) => l.spt?.n)), true),
  ly('spt_raw', 'SPT (PRINTED)', 160, (ls) => joined(ls.map((l) => l.spt?.raw)), true),
  ly('spt_refusal', 'SPT REFUSALS', 110, (ls) => count(ls.filter((l) => l.spt?.refusal).length, ls.filter((l) => l.spt).length)),
  ly('spt_depth', 'SPT DEPTHS', 120, (ls) => range(ls.map((l) => l.spt?.depth), 'm'), true),
];

const tr = (column: string, label: string, min: number, text: (b: Borehole) => string, mono = true): FieldDef =>
  ({ key: `test_results.${column}`, group: 'Test results', column, label, min, mono, text });
const TESTS: FieldDef[] = [
  tr('test_result_id', 'TEST RESULTS', 100, (b) => String(b.testResults?.length ?? 0)),
  tr('sample_name', 'SAMPLES', 140, (b) => joined((b.testResults ?? []).map((t) => t.sampleName))),
  tr('sample_type', 'SAMPLE TYPES', 120, (b) => joined((b.testResults ?? []).map((t) => t.sampleType)), false),
  tr('sample_depth', 'SAMPLE DEPTHS', 130, (b) => range((b.testResults ?? []).map((t) => t.depth), 'm')),
  ...TEST_FIELDS.map((f) => tr(f.key, f.label.toUpperCase(), Math.max(110, f.label.length * 8 + 30),
    (b) => range((b.testResults ?? []).map((t) => t.values.find((v) => v.key === f.key)?.value), f.unit))),
];

const gw = (type: Borehole['groundwater'][number]['type'], label: string): FieldDef => ({
  key: `groundwater.${type}`, group: 'Groundwater', column: `groundwater[].type = ${type}`, label, min: 110, mono: true,
  text: (b) => range(b.groundwater.filter((g) => g.type === type).map((g) => g.depth), 'm'),
});
const GROUNDWATER: FieldDef[] = [
  { key: 'groundwater.count', group: 'Groundwater', column: 'groundwater[]', label: 'GW READINGS', min: 110, mono: true, text: (b) => String(b.groundwater.length) },
  gw('strike', 'GW STRIKE'),
  gw('rest', 'GW REST LEVEL'),
  gw('standpipe', 'GW STANDPIPE'),
];

const JOINTS: FieldDef[] = [
  { key: 'joints.joint_id', group: 'Joints', column: 'joint_id', label: 'JOINTS', min: 80, mono: true, text: (b) => String(b.joints?.length ?? 0) },
  { key: 'joints.dip', group: 'Joints', column: 'dip_direction / dip', label: 'DIP', min: 140, mono: true,
    text: (b) => joined((b.joints ?? []).map((j) => `${j.dipDirection}/${j.dip}`)) },
  { key: 'joints.depth', group: 'Joints', column: 'depth', label: 'JOINT DEPTHS', min: 130, mono: true, text: (b) => range((b.joints ?? []).map((j) => j.depth), 'm') },
];

const DOCUMENT: FieldDef[] = [
  { key: 'documents.file_name', group: 'Document', column: 'file_name', label: 'SOURCE FILE', min: 160, text: (b) => b.sourceFile || NONE },
  { key: 'documents.document_id', group: 'Document', column: 'document_id', label: 'DOCUMENT ID', min: 140, mono: true, text: (b) => b.documentId ?? NONE },
];

/** All fields the LIST can show, in README_data order, grouped. */
export const FIELDS: readonly FieldDef[] = [...BOREHOLE, ...LAYERS, ...TESTS, ...GROUNDWATER, ...JOINTS, ...DOCUMENT];
export const FIELD_GROUPS: readonly FieldGroup[] = ['Borehole', 'Layers', 'Test results', 'Groundwater', 'Joints', 'Document'];
export const fieldByKey = new Map(FIELDS.map((f) => [f.key, f]));
