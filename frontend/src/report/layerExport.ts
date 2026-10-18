/**
 * The selection's layers as a table, one row per layer (what an engineer hands to a tunnel designer):
 * borehole, depths and elevations, description as printed and in English, DIN 4023 code, stratigraphy,
 * whether it is reviewed and how certain, and where it was read (file and page). A borehole without
 * layers still gets one row. Numbers the source doesn't state stay empty (never 0); text it doesn't
 * state reads "not in source". CSV (UTF-8 with BOM) and xlsx (exceljs, loaded on demand).
 */
import { certaintyOf } from '../domain/certainty';
import { K } from '../domain/keys';
import type { Borehole, ExtractedValue, Layer } from '../domain/types';
import { csvBlob } from '../export/csv';
import { XLSX_MIME, type Cell } from '../export/standardXlsx';
import { APP_NAME } from '../config';
import { elevationDatum, groundLevel, sourceOf } from './reportModel';

export const NOT_IN_SOURCE = 'not in source';

export const LAYER_COLUMNS = [
  'No',
  'BoreholeID',
  'BoreholeName',
  'Project',
  'Chainage_m',
  'Offset_m',
  'Side',
  'GroundLevel_m',
  'ElevationDatum',
  'Layer',
  'DepthFrom_m',
  'DepthTo_m',
  'Thickness_m',
  'TopElevation_m',
  'BottomElevation_m',
  'Description_AsPrinted',
  'Description_English',
  'DIN4023',
  'DIN4023_Notation',
  'Stratigraphy',
  'Reviewed',
  'Certainty',
  'SourceDocument',
  'Page',
] as const;

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);
const stated = (v: ExtractedValue | undefined): v is ExtractedValue => !!v && v.state === 'ok' && !!v.value.trim();

/** "yes" when every value the layer row shows is approved, "no" when one isn't, '' without values. */
function reviewed(values: (ExtractedValue | undefined)[]): string {
  const shown = values.filter((v): v is ExtractedValue => !!v && v.hasProvenance);
  if (!shown.length) return '';
  return shown.every((v) => v.status === 'approved') ? 'yes' : 'no';
}

/** The least certain of the row's values: flagged, unsure, else sure ('' without values). */
function certainty(values: (ExtractedValue | undefined)[]): string {
  const kinds = values.filter((v): v is ExtractedValue => !!v && v.hasProvenance && v.state === 'ok').map((v) => certaintyOf(v).kind);
  if (!kinds.length) return '';
  if (kinds.includes('flagged')) return 'flagged';
  return kinds.includes('unsure') ? 'unsure' : 'sure';
}

export interface LineInfo { chainageM: number; offsetM: number; side: string }

function nameOf(b: Borehole): string {
  const v = valueOf(b, K.boreholeName);
  return stated(v) ? v.value : '';
}

function layerRow(b: Borehole, no: number, l: Layer | null, line: LineInfo | undefined): Cell[] {
  const gl = groundLevel(b);
  const src = sourceOf(b);
  const lith = l ? valueOf(b, K.lithology(l.n)) : undefined;
  const bottom = l ? valueOf(b, K.bottom(l.n)) : undefined;
  const strat = l ? valueOf(b, K.strat(l.n)) : undefined;
  const values = [lith, bottom, strat];
  const page = lith?.page ?? bottom?.page ?? src.page;
  const printed = l ? lith?.raw || l.lithologyAsPrinted : '';
  const english = l ? (stated(lith) ? lith.value : l.lithology) : '';
  const stratText = l ? (stated(strat) ? strat.value : (l.stratigraphicName ?? '')) : '';
  return [
    no,
    b.id,
    nameOf(b),
    b.project,
    line ? round(line.chainageM, 1) : null,
    line ? round(line.offsetM, 1) : null,
    line ? line.side : null,
    gl,
    gl != null ? elevationDatum(b) : null,
    l ? l.n : null,
    l ? round(l.from) : null,
    l ? round(l.to) : null,
    l ? round(l.to - l.from) : null,
    l && gl != null ? round(gl - l.from) : null,
    l && gl != null ? round(gl - l.to) : null,
    l ? printed || NOT_IN_SOURCE : 'no layers in source',
    l ? english || NOT_IN_SOURCE : null,
    l ? (l.din ?? NOT_IN_SOURCE) : null,
    l ? l.dinNotation : null,
    l ? stratText || NOT_IN_SOURCE : null,
    reviewed(values),
    certainty(values),
    src.file,
    page,
  ];
}

/** Header row plus one row per layer of every borehole, in report order. */
export function layerRows(records: readonly Borehole[], lines?: ReadonlyMap<string, LineInfo>): Cell[][] {
  const rows: Cell[][] = [[...LAYER_COLUMNS]];
  records.forEach((b, i) => {
    const line = lines?.get(b.uid);
    if (!b.layers.length) rows.push(layerRow(b, i + 1, null, line));
    for (const l of b.layers) rows.push(layerRow(b, i + 1, l, line));
  });
  return rows;
}

export function layersCsv(records: readonly Borehole[], lines?: ReadonlyMap<string, LineInfo>): Blob {
  return csvBlob(layerRows(records, lines));
}

/** The layers (and the summary rows) as an xlsx workbook. */
export async function layersXlsx(records: readonly Borehole[], summary: Cell[][], lines?: ReadonlyMap<string, LineInfo>): Promise<Blob> {
  const mod = await import('exceljs');
  const ExcelJS = ('default' in mod ? mod.default : mod) as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME;
  const sheets: [string, Cell[][]][] = [
    ['Layers', layerRows(records, lines)],
    ['Boreholes', summary],
  ];
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns.forEach((c) => {
      c.width = 16;
    });
  }
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_MIME });
}

/** A file name from the selection title: "Trasse Nord" → "Trasse_Nord_layers.csv". */
export function reportFileName(base: string, suffix: string, ext: string): string {
  const safe = base.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'selection';
  return `${safe}_${suffix}.${ext}`;
}
