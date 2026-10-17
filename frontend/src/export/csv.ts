/** Tidy CSV (one row per value) and the open-questions CSV (the client RFI list), as in the prototype. */
import type { Borehole, DocumentSummary } from '../domain/types';
import { exportId, isExported, type Cell, type ExportOptions } from './standardXlsx';

/**
 * One row per exported value (every field the source states, samples and test results included).
 * Values that aren't "ok" (not in source, illegible) have a blank value. The borehole column is the
 * same ID the xlsx export uses (a corrected BoreholeID once approved). The page column holds the
 * spreadsheet cell ("Sheet!C5") for a spreadsheet value.
 */
export function tidyRows(boreholes: Borehole[], o: ExportOptions): Cell[][] {
  const rows: Cell[][] = [['borehole', 'field', 'layer', 'raw', 'value', 'unit', 'page', 'method', 'status', 'state']];
  for (const b of boreholes) {
    const id = exportId(b, o);
    for (const v of b.values) {
      if (!isExported(v, o)) continue;
      const source = v.page ?? v.cell ?? null;
      rows.push([id, v.label, v.layer ?? '', v.raw, v.state === 'ok' ? v.value : '', v.unit, source, v.method, v.status, v.state]);
    }
  }
  return rows;
}

/**
 * Questions for the client: missing borehole IDs, CRS not stated or unknown, lint findings,
 * flags and illegible values.
 */
export function openQuestionRows(
  boreholes: Borehole[],
  doc: DocumentSummary | null,
  o: ExportOptions = { includeUnreviewed: false },
): Cell[][] {
  const rows: Cell[][] = [['borehole', 'page', 'question']];
  for (const id of doc?.completeness?.missing ?? []) {
    rows.push([id, '', 'Report names this borehole but no log was found. Please supply.']);
  }
  const inferred = boreholes.find((b) => b.crs.status === 'inferred');
  if (inferred) {
    const crsPage = inferred.values.find((v) => v.kind === 'crs')?.page ?? inferred.primaryPage;
    const guess = inferred.crs.name ? ` (we infer ${inferred.crs.name})` : '';
    rows.push(['all', crsPage, `Coordinate system not stated. Please confirm${guess}.`]);
  }
  for (const b of boreholes) {
    const id = exportId(b, o);
    if (b.crs.status === 'unknown') {
      rows.push([id, b.primaryPage, 'Coordinate system unknown. Please supply it, or the transformation to a known one.']);
    }
    for (const v of b.values) {
      const where = v.page ?? v.cell ?? null;
      if (v.lint) rows.push([id, where, v.lint.message]);
      if (v.flag) rows.push([id, where, `${v.label}: ${v.flag}`]);
      if (v.state === 'illegible') rows.push([id, where, `${v.label} is illegible in the source.`]);
    }
  }
  return rows;
}

/** Serialises rows as CSV with every cell quoted; null is an empty cell. */
export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** CSV blob with a UTF-8 byte-order mark so spreadsheet apps read umlauts correctly. */
export function csvBlob(rows: Cell[][]): Blob {
  return new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' });
}
