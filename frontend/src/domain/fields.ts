/**
 * Every column of the data model (README_data.md) the LIST can show for one borehole, grouped by its
 * table (from frontend_din, on this app's Borehole). Borehole columns show their value; layer,
 * sample / test, and groundwater columns summarise the borehole's rows: codes joined ("T · U · G"),
 * numbers as a range ("12–28 %"), yes / no as a count ("2 of 6").
 *
 * A column whose value the map layer already has (final depth, CRS, the document) reads it from the
 * light row (`light`); every other column needs the full record (`text`), which LIST loads on demand.
 * NONE ("–", "not in source") is what the source doesn't state: never a guess, never a 0. README columns
 * this app's record does not hold (joints, TBM assessment, USCS group, timestamps …) are not offered.
 */
import { K } from './keys';
import { metres } from './format';
import type { Borehole, CrsStatus, Layer } from './types';
import { section } from '../schema/targetFormat';

export type FieldGroup = 'Borehole' | 'Layers' | 'Samples and tests' | 'Groundwater' | 'Document';

/** What a column can read without the full record: the row the map layer gives. */
export interface LightRow {
  depth: number | null;
  crs: Borehole['crs'];
  document: string;
  documentId: string | null;
}

export interface FieldCell {
  text: string;
  /** Amber: the value needs a look (an inferred or unknown CRS). */
  warn?: boolean;
}

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
  /** From the light row: no full record needed; null when the light row doesn't hold it (then the record). */
  light?(r: LightRow): FieldCell | null;
  /** From the full record. */
  text(b: Borehole): FieldCell;
}

/** Shown for a value the source does not state. */
export const NONE = '–';
export const NONE_TITLE = 'Not in source';

const cell = (text: string, warn = false): FieldCell => ({ text: text || NONE, warn });
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const m = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? metres(v) : NONE);

/** Distinct texts joined with " · " ("–" for none). */
export function joined(vals: (string | null | undefined)[]): string {
  return [...new Set(vals.map((v) => v?.trim()).filter((v): v is string => !!v))].join(' · ') || NONE;
}

/** "12–28 %", "3.1 m" (one value), "–" (none). */
export function range(vals: (number | null | undefined)[], unit = ''): string {
  const ns = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (!ns.length) return NONE;
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  const body = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  return unit ? `${body} ${unit}` : body;
}

/** "2 of 6"; "–" when there are no rows to count. */
export const countOf = (n: number, of: number) => (of ? `${n} of ${of}` : NONE);

/** A borehole value by its key, with its unit ("35.7 m"); "–" when it is empty. */
export function valueText(b: Borehole, key: string): string {
  const v = b.values.find((x) => x.key === key);
  const text = v?.value?.trim();
  if (!text) return NONE;
  return v?.unit && v.unit !== '-' ? `${text} ${v.unit}` : text;
}

/** The CRS as named: label (or the name as printed) with its code, else the code. */
export function crsName(crs: Borehole['crs']): string {
  const name = crs.label?.trim() || crs.name?.trim();
  const code = crs.code?.trim();
  if (name) return code && !name.includes(code) ? `${name} (${code})` : name;
  return code || NONE;
}

const crsWarn = (status: CrsStatus) => status === 'inferred' || status === 'unknown';

const bv = (column: string, label: string, key: string, min = 140, mono = false): FieldDef => ({
  key: `boreholes.${column}`, group: 'Borehole', column, label, min, mono, text: (b) => cell(valueText(b, key)),
});

const BOREHOLE: FieldDef[] = [
  bv('location_name', 'LOCATION', K.locationName, 160),
  bv('start_date', 'START DATE', K.startDate, 110, true),
  bv('end_date', 'END DATE', K.endDate, 110, true),
  bv('project_id', 'PROJECT ID', K.projectId, 110, true),
  bv('country', 'COUNTRY', K.country, 120),
  bv('client', 'CLIENT', K.client, 160),
  bv('drilling_contractor', 'DRILLING CONTRACTOR', K.contractor, 170),
  bv('drilling_method', 'DRILLING METHOD', K.method, 150),
  bv('surface_elevation', 'SURFACE ELEVATION', K.elevation, 130, true),
  { key: 'boreholes.elevation_datum', group: 'Borehole', column: 'elevation_datum', label: 'ELEVATION DATUM', min: 130, text: (b) => cell(b.meta.elevationDatum ?? '') },
  { key: 'boreholes.x-coordinate', group: 'Borehole', column: 'x-coordinate', label: 'LONGITUDE', min: 110, mono: true, text: (b) => cell(b.lng == null ? '' : b.lng.toFixed(4)) },
  { key: 'boreholes.y-coordinate', group: 'Borehole', column: 'y-coordinate', label: 'LATITUDE', min: 110, mono: true, text: (b) => cell(b.lat == null ? '' : b.lat.toFixed(4)) },
  {
    key: 'boreholes.coordinate_system', group: 'Borehole', column: 'coordinate_system', label: 'CRS', min: 170,
    // The map layer names the system since 1.2.0; without a name or code there, the record says.
    light: (r) => (crsName(r.crs) === NONE ? null : cell(crsName(r.crs), r.crs.status === 'inferred')),
    text: (b) => cell(crsName(b.crs), b.crs.status === 'inferred'),
  },
  { key: 'boreholes.local_x', group: 'Borehole', column: 'local_x', label: 'LOCAL X', min: 120, mono: true, text: (b) => cell(b.meta.localX == null ? b.meta.xRaw ?? '' : String(b.meta.localX)) },
  { key: 'boreholes.local_y', group: 'Borehole', column: 'local_y', label: 'LOCAL Y', min: 120, mono: true, text: (b) => cell(b.meta.localY == null ? b.meta.yRaw ?? '' : String(b.meta.localY)) },
  {
    key: 'boreholes.crs_status', group: 'Borehole', column: 'crs_status', label: 'CRS STATUS', min: 110,
    light: (r) => cell(r.crs.status, crsWarn(r.crs.status)),
    text: (b) => cell(b.crs.status, crsWarn(b.crs.status)),
  },
  {
    key: 'boreholes.borehole_depth', group: 'Borehole', column: 'borehole_depth', label: 'FINAL DEPTH', min: 110, mono: true,
    light: (r) => cell(r.depth != null && r.depth > 0 ? m(r.depth) : ''),
    text: (b) => cell(b.finalDepth != null && b.finalDepth > 0 ? m(b.finalDepth) : ''),
  },
  bv('borehole_length', 'BOREHOLE LENGTH', K.boreholeLength, 130, true),
  bv('inclination', 'INCLINATION', K.inclination, 110, true),
  bv('casing_info', 'CASING', K.casing, 160),
  { key: 'boreholes.rock_head', group: 'Borehole', column: 'rock_head', label: 'ROCK HEAD', min: 110, mono: true, text: (b) => cell(m(b.rockHead)) },
  bv('notes', 'NOTES', K.notes, 180),
];

const ly = (column: string, label: string, min: number, text: (ls: Layer[]) => string, mono = false): FieldDef => ({
  key: `layers.${column}`, group: 'Layers', column, label, min, mono, text: (b) => cell(text(b.layers)),
});

const LAYERS: FieldDef[] = [
  ly('position', 'LAYERS', 80, (ls) => String(ls.length), true),
  ly('depth_to', 'LOGGED DEPTH', 120, (ls) => (ls.length ? `${fmt(ls[0].from)}–${fmt(ls[ls.length - 1].to)} m` : NONE), true),
  ly('original_description', 'DESCRIPTION (PRINTED)', 260, (ls) => joined(ls.map((l) => l.lithologyAsPrinted))),
  ly('english_lithology', 'LITHOLOGY', 240, (ls) => joined(ls.map((l) => l.lithology))),
  ly('din_code', 'DIN 4023 CODES', 160, (ls) => joined(ls.map((l) => l.din)), true),
  ly('strength', 'STRENGTH', 160, (ls) => joined(ls.map((l) => l.consistency))),
  ly('colour', 'COLOUR', 140, (ls) => joined(ls.map((l) => l.colour))),
  ly('moisture', 'MOISTURE', 120, (ls) => joined(ls.map((l) => l.moisture))),
  ly('weathering', 'WEATHERING', 110, (ls) => joined(ls.map((l) => l.weathering)), true),
  ly('stratigraphic_name', 'FORMATION', 180, (ls) => joined(ls.map((l) => l.stratigraphicName))),
  ly('geologic_age', 'GEOLOGIC AGE', 150, (ls) => joined(ls.map((l) => l.geologicAge))),
  ly('core', 'CORED LAYERS', 110, (ls) => countOf(ls.filter((l) => l.isCore).length, ls.filter((l) => l.isCore != null).length)),
  ly('total_core_recovery', 'TCR', 100, (ls) => range(ls.map((l) => l.tcr), '%'), true),
  ly('rqd', 'RQD', 100, (ls) => range(ls.map((l) => l.rqd), '%'), true),
  ly('spt_n_value', 'SPT N', 90, (ls) => range(ls.map((l) => l.spt?.n)), true),
  ly('spt_raw', 'SPT (PRINTED)', 160, (ls) => joined(ls.map((l) => l.spt?.raw)), true),
  ly('spt_refusal', 'SPT REFUSALS', 110, (ls) => countOf(ls.filter((l) => l.spt?.refusal).length, ls.filter((l) => l.spt).length)),
  ly('spt_depth', 'SPT DEPTHS', 120, (ls) => range(ls.map((l) => l.spt?.depth), 'm'), true),
];

/** A test name without case, spaces, dashes and underscores: "friction_angle" is "FrictionAngle". */
const flatName = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

const st = (column: string, label: string, min: number, text: (b: Borehole) => string, mono = true): FieldDef => ({
  key: `test_results.${column}`, group: 'Samples and tests', column, label, min, mono, text: (b) => cell(text(b)),
});

const TESTS: FieldDef[] = [
  st('test_result_id', 'TEST RESULTS', 100, (b) => String(b.testResults.length)),
  st('sample_name', 'SAMPLES', 140, (b) => joined(b.samples.map((s) => s.name))),
  st('sample_type', 'SAMPLE TYPES', 120, (b) => joined(b.samples.map((s) => s.typeCode)), false),
  st('sample_depth', 'SAMPLE DEPTHS', 130, (b) => range(b.samples.map((s) => s.from), 'm')),
  ...section('testResults').fields.map((f) =>
    st(f.name.toLowerCase(), f.name.toUpperCase(), Math.max(110, f.name.length * 8 + 30), (b) =>
      range(
        b.testResults.filter((t) => flatName(t.name) === flatName(f.name)).map((t) => t.value),
        f.unit === '-' ? '' : f.unit,
      ),
    ),
  ),
];

const gw = (type: Borehole['groundwater'][number]['type'], label: string): FieldDef => ({
  key: `groundwater.${type}`, group: 'Groundwater', column: `groundwater[].type = ${type}`, label, min: 110, mono: true,
  text: (b) => cell(range(b.groundwater.filter((g) => g.type === type).map((g) => g.depth), 'm')),
});

const GROUNDWATER: FieldDef[] = [
  { key: 'groundwater.count', group: 'Groundwater', column: 'groundwater[]', label: 'GW READINGS', min: 110, mono: true, text: (b) => cell(String(b.groundwater.length)) },
  gw('strike', 'GW STRIKE'),
  gw('rest', 'GW REST LEVEL'),
  gw('standpipe', 'GW STANDPIPE'),
];

const DOCUMENT: FieldDef[] = [
  {
    key: 'documents.file_name', group: 'Document', column: 'file_name', label: 'SOURCE FILE', min: 160,
    light: (r) => cell(r.document), text: (b) => cell(b.sourceFile),
  },
  {
    key: 'documents.document_id', group: 'Document', column: 'document_id', label: 'DOCUMENT ID', min: 140, mono: true,
    light: (r) => cell(r.documentId ?? ''), text: (b) => cell(b.documentId ?? ''),
  },
];

/** All fields the LIST can show, in README_data order, grouped. */
export const FIELDS: readonly FieldDef[] = [...BOREHOLE, ...LAYERS, ...TESTS, ...GROUNDWATER, ...DOCUMENT];
export const FIELD_GROUPS: readonly FieldGroup[] = ['Borehole', 'Layers', 'Samples and tests', 'Groundwater', 'Document'];
export const fieldByKey = new Map(FIELDS.map((f) => [f.key, f]));

/** Shown until the user picks others: final depth, CRS status and CRS (frontend_din). */
export const DEFAULT_COLUMNS = ['boreholes.borehole_depth', 'boreholes.crs_status', 'boreholes.coordinate_system'];

/** True when the column needs the full record for this row (the light row of the map layer does not hold it). */
export const needsRecord = (f: FieldDef, r?: LightRow) => !f.light || (r ? f.light(r) === null : false);
