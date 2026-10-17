/**
 * Target-format workbook (BoreholeDataFormat): Metadata, Logdata, Test Results and a Provenance
 * sheet, built from schema/targetFormat.ts. Every column is filled from the reviewed values; fields
 * the app reads beyond the template follow the template's columns. Row building is pure; exceljs is
 * loaded on demand.
 */
import { APP_NAME } from '../config';
import { parseNumber } from '../domain/format';
import { K } from '../domain/keys';
import { refusalText } from '../domain/spt';
import type { Borehole, ExtractedValue, Layer, Sample, TestResult } from '../domain/types';
import { EXTRA_FIELDS, MULTI_FIELD_SEPARATOR, section, type FieldDef } from '../schema/targetFormat';

export type Cell = string | number | null;
export interface SheetData {
  name: string;
  rows: Cell[][];
  /** 0-based index of the field-name row (1 when a DRAFT title row comes first). */
  headerRow: number;
}
export interface ExportOptions {
  includeUnreviewed: boolean;
}

export const DRAFT_TITLE = 'DRAFT – NOT APPROVED';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Borehole fields beyond the template, appended after the Metadata columns. */
export const EXTRA_METADATA: readonly FieldDef[] = [
  { name: EXTRA_FIELDS.drillingMethod, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.elevationDatum, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.depthOrigin, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.inclination, format: 'numeric', unit: '°' },
];

/** Layer fields beyond the template, appended after the Logdata columns. */
export const EXTRA_LOGDATA: readonly FieldDef[] = [
  { name: EXTRA_FIELDS.colour, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.consistency, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.moisture, format: 'alphanumeric', unit: '-' },
  { name: EXTRA_FIELDS.weathering, format: 'alphanumeric', unit: '-' },
];

const SAMPLE_NAME = 'SampleName';
const SAMPLE_DEPTH = 'SampleDepth';

/** True if a value goes into an export: approved, or any value in a draft. */
export function isExported(v: ExtractedValue, o: ExportOptions): boolean {
  return o.includeUnreviewed || v.status === 'approved';
}

/** Cell for one target field from a value. Excluded, empty and "not in source" values are blank, never 0. */
function cellOf(v: ExtractedValue | undefined, f: Pick<FieldDef, 'format'>, o: ExportOptions, part?: number): Cell {
  if (!v || !isExported(v, o) || v.state !== 'ok') return null;
  // A refusal is exported as printed ("50/30"), or as the reviewer entered it; never as N.
  if (v.spt) return v.spt.refusal ? (v.method === 'Edited' ? refusalText(v.spt, v.value) : v.raw) : (v.spt.n ?? null);
  const text = part == null ? v.value : (v.value.split(MULTI_FIELD_SEPARATOR)[part] ?? '');
  if (!text) return null;
  return f.format === 'numeric' ? (parseNumber(text) ?? text) : text;
}

/** Finds the value that holds a target field (a two-field value like X / Y also returns its part index). */
function findField(values: ExtractedValue[], name: string): { v: ExtractedValue; part?: number } | undefined {
  for (const v of values) {
    const parts = v.field.split(MULTI_FIELD_SEPARATOR);
    const i = parts.indexOf(name);
    if (i >= 0) return { v, part: parts.length > 1 ? i : undefined };
  }
  return undefined;
}

const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);
const NUMERIC = { format: 'numeric' } as const;

/**
 * The BoreholeID every sheet and CSV row carries: the reviewed BoreholeID value when the export
 * includes it, else the ID as printed. One ID per borehole, so the sheets still join after a correction.
 */
export function exportId(b: Borehole, o: ExportOptions): string {
  const v = valueOf(b, K.boreholeId);
  return (v && isExported(v, o) && v.state === 'ok' && v.value.trim()) || b.id;
}

function withHeader(name: string, names: string[], units: string[], data: Cell[][], o: ExportOptions): SheetData {
  const title = o.includeUnreviewed ? [[DRAFT_TITLE]] : [];
  return { name, rows: [...title, names, units, ...data], headerRow: title.length };
}

/**
 * One Metadata row. The first column (BoreholeID) is the key that joins the row to the Logdata,
 * Test Results and Provenance rows: all of them use exportId, so an approved-only export has no
 * anonymous rows and a corrected ID is the same on every sheet.
 */
function metadataRow(b: Borehole, fields: readonly FieldDef[], o: ExportOptions): Cell[] {
  const boreholeLevel = b.values.filter((v) => v.group === 'borehole');
  return fields.map((f, i) => {
    if (i === 0) return exportId(b, o);
    const hit = findField(boreholeLevel, f.name);
    return cellOf(hit?.v, f, o, hit?.part);
  });
}

/** True if a depth lies in a layer (the last layer includes its bottom). */
function inLayer(d: number | null, l: Layer, isLast: boolean): d is number {
  return d != null && d >= l.from && (d < l.to || (isLast && d === l.to));
}

const DEPTH_COL = { name: EXTRA_FIELDS.depthTo, format: 'numeric', unit: 'm' } as const;

/**
 * DepthFrom of a layer: its own start depth. When it continues the layer above, that is the reviewed
 * bottom of that layer (blank until approved); a first layer, or one after a gap or overlap, keeps
 * the start depth from the source, so gaps and overlaps survive the export.
 */
function depthFrom(b: Borehole, l: Layer, above: Layer | undefined, o: ExportOptions): Cell {
  if (!above || Math.abs(above.to - l.from) > 0.005) return l.from;
  return cellOf(valueOf(b, K.bottom(above.n)), DEPTH_COL, o);
}

/** The values of one sample (its name and depth), by the sample's index in the borehole's list. */
function sampleValues(b: Borehole, i: number): { name?: ExtractedValue; depth?: ExtractedValue } {
  const own = b.values.filter((v) => v.group === 'sample' && v.index === i);
  return { name: own.find((v) => v.field === SAMPLE_NAME), depth: own.find((v) => v.field === SAMPLE_DEPTH) };
}

/**
 * Sample cells of a layer row: the samples whose top lies in the layer. One sample gives its name
 * and depth; several are listed as text ("S1, S2" / "1.5, 3"). Unreviewed parts stay blank.
 */
function layerSampleCells(b: Borehole, l: Layer, isLast: boolean, o: ExportOptions): { name: Cell; depth: Cell } {
  const cells = b.samples
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => inLayer(s.from, l, isLast))
    .map(({ i }) => {
      const sv = sampleValues(b, i);
      return { name: cellOf(sv.name, { format: 'alphanumeric' }, o), depth: cellOf(sv.depth, NUMERIC, o) };
    });
  if (cells.length <= 1) return { name: cells[0]?.name ?? null, depth: cells[0]?.depth ?? null };
  const join = (xs: Cell[]) => xs.filter((x) => x != null && x !== '').join(', ') || null;
  return { name: join(cells.map((c) => c.name)), depth: join(cells.map((c) => c.depth)) };
}

function logRow(b: Borehole, l: Layer, i: number, fields: readonly FieldDef[], o: ExportOptions): Cell[] {
  const isLast = i === b.layers.length - 1;
  const from = depthFrom(b, l, b.layers[i - 1], o);
  const to = cellOf(valueOf(b, K.bottom(l.n)), DEPTH_COL, o);
  const lith = valueOf(b, K.lithology(l.n));
  const lithOk = !!lith && isExported(lith, o) && lith.state === 'ok';
  const layerValues = b.values.filter((v) => v.layer === l.n);
  const samples = layerSampleCells(b, l, isLast, o);
  const cells = fields.map((f): Cell => {
    if (f.layerProp) return lithOk ? l[f.layerProp] || null : null;
    if (f.name === SAMPLE_NAME) return samples.name;
    if (f.name === SAMPLE_DEPTH) return samples.depth;
    const hit = findField(layerValues, f.name);
    if (hit) return cellOf(hit.v, f, o, hit.part);
    // Borehole-level readings of a log field (groundwater) go to the layer that contains their depth.
    const atDepth = b.values.find(
      (v) =>
        (v.group === 'groundwater' || v.group === 'borehole') &&
        findField([v], f.name) &&
        isExported(v, o) &&
        inLayer(parseNumber(v.value), l, isLast),
    );
    return cellOf(atDepth, f, o);
  });
  return [exportId(b, o), from, to, ...cells];
}

/** One group of the Test Results sheet: a sample (and the tests on it) or the tests at one depth. */
interface TestGroup { sampleName: Cell; sampleDepth: Cell; tests: { t: TestResult; i: number }[] }

/**
 * Test Results rows: one per sample (with the tests named after it), then one per depth for tests
 * without a sample. The sample name and the depth of a depth group are the row's key (like the
 * BoreholeID): the name falls back to the one printed; every result cell is blank until approved.
 */
function testGroups(b: Borehole, o: ExportOptions): TestGroup[] {
  const tests = b.testResults.map((t, i) => ({ t, i }));
  const bySample = (s: Sample) => tests.filter(({ t }) => t.sampleName != null && t.sampleName === s.name);
  const groups: TestGroup[] = b.samples.map((s, i) => {
    const sv = sampleValues(b, i);
    return {
      sampleName: cellOf(sv.name, { format: 'alphanumeric' }, o) ?? (s.name || null),
      sampleDepth: cellOf(sv.depth, NUMERIC, o),
      tests: bySample(s),
    };
  });
  const placed = new Set(groups.flatMap((g) => g.tests.map((x) => x.i)));
  const byDepth = new Map<string, TestGroup>();
  for (const x of tests) {
    if (placed.has(x.i)) continue;
    const id = `${x.t.sampleName ?? ''}\n${x.t.depth ?? ''}`;
    const g = byDepth.get(id) ?? { sampleName: x.t.sampleName, sampleDepth: x.t.depth, tests: [] };
    g.tests.push(x);
    byDepth.set(id, g);
  }
  return [...groups, ...byDepth.values()];
}

/** The Test Results rows of one borehole; a field measured twice in one group starts another row. */
function testRows(b: Borehole, fields: readonly FieldDef[], o: ExportOptions): Cell[][] {
  const id = exportId(b, o);
  return testGroups(b, o).flatMap((g) => {
    const rows: (ExtractedValue | undefined)[][] = [];
    for (const { t, i } of g.tests) {
      const col = fields.findIndex((f) => f.name === t.name);
      if (col < 0) continue;
      const v = valueOf(b, t.key) ?? b.values.find((x) => x.group === 'test' && x.index === i);
      let row = rows.find((r) => r[col] === undefined);
      if (!row) {
        row = Array<ExtractedValue | undefined>(fields.length).fill(undefined);
        rows.push(row);
      }
      row[col] = v;
    }
    if (!rows.length) rows.push(Array<ExtractedValue | undefined>(fields.length).fill(undefined));
    return rows.map((r) => [id, g.sampleName, g.sampleDepth, ...r.map((v, c) => cellOf(v, fields[c], o))]);
  });
}

/** Builds the four sheets as rows: row 1 field names, row 2 units (after a DRAFT title row in drafts). */
export function buildStandardSheets(boreholes: Borehole[], o: ExportOptions): SheetData[] {
  const meta = section('metadata');
  const log = section('logdata');
  const tests = section('testResults');
  const idField = meta.fields[0];
  const sampleCols = log.fields.filter((f) => f.name === SAMPLE_NAME || f.name === SAMPLE_DEPTH);
  const metaFields = [...meta.fields, ...EXTRA_METADATA];
  const logFields = [...log.fields, ...EXTRA_LOGDATA];

  const metadata = withHeader(
    meta.title,
    metaFields.map((f) => f.name),
    metaFields.map((f) => f.unit),
    boreholes.map((b) => metadataRow(b, metaFields, o)),
    o,
  );
  const logdata = withHeader(
    log.title,
    [idField.name, EXTRA_FIELDS.depthFrom, EXTRA_FIELDS.depthTo, ...logFields.map((f) => f.name)],
    [idField.unit, 'm', 'm', ...logFields.map((f) => f.unit)],
    boreholes.flatMap((b) => b.layers.map((l, i) => logRow(b, l, i, logFields, o))),
    o,
  );
  const testResults = withHeader(
    tests.title,
    [idField.name, ...sampleCols.map((f) => f.name), ...tests.fields.map((f) => f.name)],
    [idField.unit, ...sampleCols.map((f) => f.unit), ...tests.fields.map((f) => f.unit)],
    boreholes.flatMap((b) => testRows(b, tests.fields, o)),
    o,
  );
  const provenance = withHeader(
    'Provenance',
    [idField.name, 'key', 'field', 'raw', 'value', 'unit', 'page', 'method', 'status', 'state'],
    ['-', '-', '-', '-', '-', '-', 'page or cell', '-', '-', '-'],
    boreholes.flatMap((b) => {
      const id = exportId(b, o);
      return b.values
        .filter((v) => isExported(v, o))
        .map((v) => [id, v.key, v.field, v.raw, v.state === 'ok' ? v.value : '', v.unit, v.page ?? v.cell ?? null, v.method, v.status, v.state]);
    }),
    o,
  );
  return [metadata, logdata, testResults, provenance];
}

/** Builds the target-format workbook as an xlsx Blob. */
export async function exportStandardXlsx(boreholes: Borehole[], o: ExportOptions): Promise<Blob> {
  const mod = await import('exceljs');
  const ExcelJS = ('default' in mod ? mod.default : mod) as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME;
  for (const s of buildStandardSheets(boreholes, o)) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r) => ws.addRow(r));
    if (s.headerRow > 0) ws.getRow(1).font = { bold: true, color: { argb: 'FFC8102E' } };
    ws.getRow(s.headerRow + 1).font = { bold: true };
    ws.getRow(s.headerRow + 2).font = { italic: true, color: { argb: 'FF555555' } };
    ws.views = [{ state: 'frozen', ySplit: s.headerRow + 2 }];
    ws.columns.forEach((c) => {
      c.width = 16;
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}
