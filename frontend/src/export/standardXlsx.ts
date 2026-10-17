/**
 * Target-format workbook (Herrenknecht BoreholeDataFormat): Metadata, Logdata, Test Results and a
 * Provenance sheet, built from schema/targetFormat.ts. Row building is pure; exceljs is loaded on demand.
 */
import { parseNumber } from '../domain/format';
import { K } from '../domain/keys';
import { refusalText } from '../domain/spt';
import type { Borehole, ExtractedValue, Layer } from '../domain/types';
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

/** True if a value goes into an export: approved, or any value in a draft. */
export function isExported(v: ExtractedValue, o: ExportOptions): boolean {
  return o.includeUnreviewed || v.status === 'approved';
}

/** Cell for one target field from a value. Excluded, empty and "not in source" values are blank, never 0. */
function cellOf(v: ExtractedValue | undefined, f: FieldDef, o: ExportOptions, part?: number): Cell {
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
  const boreholeLevel = b.values.filter((v) => v.layer == null);
  return fields.map((f, i) => {
    if (i === 0) return exportId(b, o);
    const hit = findField(boreholeLevel, f.name);
    return cellOf(hit?.v, f, o, hit?.part);
  });
}

/** Borehole-level values of a log field (e.g. groundwater) go to the layer row that contains their depth. */
function depthInLayer(v: ExtractedValue, l: Layer, isLast: boolean): boolean {
  const d = parseNumber(v.value);
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

function logRow(b: Borehole, l: Layer, i: number, fields: readonly FieldDef[], o: ExportOptions): Cell[] {
  const isLast = i === b.layers.length - 1;
  const from = depthFrom(b, l, b.layers[i - 1], o);
  const to = cellOf(valueOf(b, K.bottom(l.n)), DEPTH_COL, o);
  const lith = valueOf(b, K.lithology(l.n));
  const lithOk = !!lith && isExported(lith, o) && lith.state === 'ok';
  const layerValues = b.values.filter((v) => v.layer === l.n);
  const cells = fields.map((f): Cell => {
    if (f.layerProp) return lithOk ? l[f.layerProp] || null : null;
    const hit = findField(layerValues, f.name);
    if (hit) return cellOf(hit.v, f, o, hit.part);
    const atDepth = b.values.find(
      (v) => v.layer == null && findField([v], f.name) && isExported(v, o) && depthInLayer(v, l, isLast),
    );
    return cellOf(atDepth, f, o);
  });
  return [exportId(b, o), from, to, ...cells];
}

/** Builds the four sheets as rows: row 1 field names, row 2 units (after a DRAFT title row in drafts). */
export function buildStandardSheets(boreholes: Borehole[], o: ExportOptions): SheetData[] {
  const meta = section('metadata');
  const log = section('logdata');
  const tests = section('testResults');
  const idField = meta.fields[0];
  const sampleCols = log.fields.filter((f) => f.name.startsWith('Sample'));

  const metadata = withHeader(
    meta.title,
    meta.fields.map((f) => f.name),
    meta.fields.map((f) => f.unit),
    boreholes.map((b) => metadataRow(b, meta.fields, o)),
    o,
  );
  const logdata = withHeader(
    log.title,
    [idField.name, EXTRA_FIELDS.depthFrom, EXTRA_FIELDS.depthTo, ...log.fields.map((f) => f.name)],
    [idField.unit, 'm', 'm', ...log.fields.map((f) => f.unit)],
    boreholes.flatMap((b) => b.layers.map((l, i) => logRow(b, l, i, log.fields, o))),
    o,
  );
  const testResults = withHeader(
    tests.title,
    [idField.name, ...sampleCols.map((f) => f.name), ...tests.fields.map((f) => f.name)],
    [idField.unit, ...sampleCols.map((f) => f.unit), ...tests.fields.map((f) => f.unit)],
    [],
    o,
  );
  const provenance = withHeader(
    'Provenance',
    [idField.name, 'key', 'field', 'raw', 'value', 'unit', 'page', 'method', 'status', 'state'],
    ['-', '-', '-', '-', '-', '-', '-', '-', '-', '-'],
    boreholes.flatMap((b) => {
      const id = exportId(b, o);
      return b.values
        .filter((v) => isExported(v, o))
        .map((v) => [id, v.key, v.field, v.raw, v.state === 'ok' ? v.value : '', v.unit, v.page, v.method, v.status, v.state]);
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
  wb.creator = 'Bormisu';
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
