import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import { applyValuePatch } from '../domain/review';
import type { Borehole } from '../domain/types';
import { multiField } from '../schema/targetFormat';
import { makeBorehole, makeLayer, makeValue } from '../test/fixtures';
import { tidyRows } from './csv';
import { buildStandardSheets, DRAFT_TITLE, exportStandardXlsx, XLSX_MIME } from './standardXlsx';

const approveAll = (b: Borehole): Borehole => ({ ...b, values: b.values.map((v) => ({ ...v, status: 'approved' })) });

function borehole(): Borehole {
  const b = makeBorehole();
  return {
    ...b,
    values: [
      ...b.values,
      makeValue({ key: K.xy, field: multiField('X-Coordinate', 'Y-Coordinate'), value: '512000 / 5540000' }),
      makeValue({ key: K.notes, field: 'Notes', state: 'not in source' }),
      makeValue({
        key: K.spt(2), field: 'SPT', group: 'layer', layer: 2, raw: '50/30', value: 'refusal · 50 blows / 30 cm',
        spt: { raw: '50/30', depth: 4, refusal: true, blows: 50, penetrationCm: 30 },
      }),
    ],
  };
}

const col = (rows: unknown[][], headerRow: number, name: string) => (rows[headerRow] as string[]).indexOf(name);

describe('buildStandardSheets', () => {
  it('builds the four sheets with names in row 1 and units in row 2', () => {
    const sheets = buildStandardSheets([borehole()], { includeUnreviewed: false });
    expect(sheets.map((s) => s.name)).toEqual(['Metadata', 'Logdata', 'Test Results', 'Provenance']);
    const [meta, log, tests] = sheets;
    expect(meta.headerRow).toBe(0);
    expect(meta.rows[0]).toHaveLength(14);
    expect(meta.rows[1][7]).toBe('mASL');
    expect(log.rows[0].slice(0, 4)).toEqual(['BoreholeID', 'DepthFrom', 'DepthTo', 'StratigraphicName']);
    expect(log.rows[0]).toHaveLength(15);
    expect(tests.rows[0].slice(0, 4)).toEqual(['BoreholeID', 'SampleName', 'SampleDepth', 'Watercontent']);
    expect(tests.rows[0]).toHaveLength(22);
  });

  it('leaves unreviewed values blank (never 0) unless drafting', () => {
    const [meta, log, , prov] = buildStandardSheets([borehole()], { includeUnreviewed: false });
    // The row key stays, so the row still joins to its Logdata rows; every value is blank.
    expect(meta.rows[2][0]).toBe('TB-01');
    expect(meta.rows[2].slice(1).every((c) => c === null)).toBe(true);
    expect(log.rows[2]).toEqual(['TB-01', 0, null, ...Array(12).fill(null)]);
    expect(prov.rows).toHaveLength(2);
  });

  it('exports approved values: numbers parsed, X / Y split, refusal kept raw, groundwater by depth', () => {
    const [meta, log, , prov] = buildStandardSheets([approveAll(borehole())], { includeUnreviewed: false });
    const m = meta.rows[2];
    expect(m[col(meta.rows, 0, 'BoreholeID')]).toBe('TB-01');
    expect(m[col(meta.rows, 0, 'BoreholeDepth')]).toBe(6);
    expect(m[col(meta.rows, 0, 'X-Coordinate')]).toBe(512000);
    expect(m[col(meta.rows, 0, 'Y-Coordinate')]).toBe(5540000);
    expect(m[col(meta.rows, 0, 'Notes')]).toBeNull();
    const [row1, row2] = [log.rows[2], log.rows[3]];
    expect(row1.slice(0, 3)).toEqual(['TB-01', 0, 2.5]);
    expect(row1[col(log.rows, 0, 'Lithology/SoilName')]).toBe('Sand');
    expect(row1[col(log.rows, 0, 'Soil/Rockprofile')]).toBe('S');
    expect(row1[col(log.rows, 0, 'StratigraphicName')]).toBe('qh');
    expect(row1[col(log.rows, 0, 'Groundwaterlevel')]).toBe(1.8);
    expect(row2[col(log.rows, 0, 'Groundwaterlevel')]).toBeNull();
    expect(row2.slice(0, 3)).toEqual(['TB-01', 2.5, 6]);
    expect(row2[col(log.rows, 0, 'SPT')]).toBe('50/30');
    expect(prov.rows).toHaveLength(2 + 10);
  });

  it('writes an SPT N as a number', () => {
    const b = approveAll(borehole());
    b.values = b.values.map((v) =>
      v.key === K.spt(2) ? { ...v, spt: { raw: '3,4,5 = 9', depth: 4, refusal: false, increments: [3, 4, 5], n: 9 } } : v,
    );
    const [, log] = buildStandardSheets([b], { includeUnreviewed: false });
    expect(log.rows[3][col(log.rows, 0, 'SPT')]).toBe(9);
  });

  it('stamps drafts and includes unreviewed values', () => {
    const b = applyValuePatch(borehole(), K.finalDepth, { state: 'illegible' });
    const [meta] = buildStandardSheets([b], { includeUnreviewed: true });
    expect(meta.rows[0]).toEqual([DRAFT_TITLE]);
    expect(meta.headerRow).toBe(1);
    expect(meta.rows[3][0]).toBe('TB-01');
    expect(meta.rows[3][col(meta.rows, 1, 'BoreholeDepth')]).toBeNull();
  });
});

describe('review corrections in the export', () => {
  const approved = { includeUnreviewed: false };
  const edit = (b: Borehole, key: string, value: string) => applyValuePatch(b, key, { value, method: 'Edited', status: 'approved' });

  // Regression (c4): the review text changed from N = 8 to 9, but the xlsx still wrote 8.
  it('writes the corrected SPT N, and a refusal entered by the reviewer as blows/penetration', () => {
    const base = approveAll(borehole());
    const n8 = { raw: '3,4,5 = 8', depth: 4, refusal: false, increments: [3, 4, 5], n: 8 };
    const b = { ...base, values: base.values.map((v) => (v.key === K.spt(2) ? { ...v, raw: n8.raw, value: 'N = 8', spt: n8, refusal: false } : v)) };
    const [, log] = buildStandardSheets([edit(b, K.spt(2), 'N = 9')], approved);
    expect(log.rows[3][col(log.rows, 0, 'SPT')]).toBe(9);
    const [, refused] = buildStandardSheets([edit(b, K.spt(2), 'refusal · 50 blows / 12 cm')], approved);
    expect(refused.rows[3][col(refused.rows, 0, 'SPT')]).toBe('50/12');
  });

  // Regression (c5): Metadata said TB-99 while Logdata and Provenance kept TB-01, so the sheets no longer joined.
  it('uses a corrected BoreholeID on every sheet and in the tidy CSV', () => {
    const b = edit(approveAll(borehole()), K.boreholeId, 'TB-99');
    const sheets = buildStandardSheets([b], approved);
    const ids = sheets.flatMap((s) => s.rows.slice(s.headerRow + 2).map((r) => r[0]));
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids)).toEqual(new Set(['TB-99']));
    expect(new Set(tidyRows([b], approved).slice(1).map((r) => r[0]))).toEqual(new Set(['TB-99']));
    expect(b.uid).toBe('doc:TB-01');
    // Not approved yet: the ID as printed, everywhere.
    const draftless = buildStandardSheets([applyValuePatch(b, K.boreholeId, { status: 'unreviewed' })], approved);
    expect(new Set(draftless.flatMap((s) => s.rows.slice(2).map((r) => r[0])))).toEqual(new Set(['TB-01']));
  });

  // Regression (c6): layers 2–4 m and 5–7 m were exported as 0–4 and 4–7.
  it('exports each layer’s own start depth, keeping gaps and overlaps', () => {
    const b = approveAll(
      makeBorehole({
        layers: [makeLayer({ n: 1, from: 2, to: 4 }), makeLayer({ n: 2, from: 5, to: 7 }), makeLayer({ n: 3, from: 6.5, to: 9 })],
        values: [
          makeValue({ key: K.bottom(1), field: 'DepthTo', group: 'layer', layer: 1, value: '4.00' }),
          makeValue({ key: K.bottom(2), field: 'DepthTo', group: 'layer', layer: 2, value: '7.00' }),
          makeValue({ key: K.bottom(3), field: 'DepthTo', group: 'layer', layer: 3, value: '9.00' }),
        ],
      }),
    );
    const [, log] = buildStandardSheets([b], approved);
    expect(log.rows.slice(2).map((r) => r.slice(1, 3))).toEqual([[2, 4], [5, 7], [6.5, 9]]);
    // A layer that continues the one above takes that layer's reviewed bottom (blank until approved).
    const contiguous = makeBorehole();
    const [, log2] = buildStandardSheets([contiguous], approved);
    expect(log2.rows[3].slice(1, 3)).toEqual([null, null]);
  });
});

describe('exportStandardXlsx', () => {
  it('writes a workbook exceljs can read back', async () => {
    const blob = await exportStandardXlsx([approveAll(borehole())], { includeUnreviewed: true });
    expect(blob.type).toBe(XLSX_MIME);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Metadata', 'Logdata', 'Test Results', 'Provenance']);
    expect(wb.getWorksheet('Metadata')?.getCell('A1').value).toBe(DRAFT_TITLE);
    expect(wb.getWorksheet('Metadata')?.getCell('A4').value).toBe('TB-01');
  });
});
