/**
 * Exports of records shaped as the backend sends them after a CRS confirmation (M0 UI verification,
 * uiv-13): the confirmed system reaches the CoordinateSystem column; nothing unknown becomes 0.
 */
import { describe, expect, it, vi } from 'vitest';
import { adaptBorehole, type WireBorehole } from '../data/adapters';
import type { Borehole } from '../domain/types';
import { fixture } from '../test/contract/wire';
import { tidyRows } from './csv';
import { buildStandardSheets } from './standardXlsx';

/**
 * The fixture after POST /documents/{id}/crs on a report that printed no system: the backend sets
 * crs_code and crs_status "confirmed" but adds no provenance entry for crs_code.
 */
function confirmedRecord(): Borehole {
  const w = fixture<WireBorehole>('borehole');
  w.crs_status = 'confirmed';
  w.metadata.coordinates = { ...w.metadata.coordinates, coordinate_system: null, crs_code: 'EPSG:2193' };
  delete w.provenance['metadata.coordinates.coordinate_system'];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    return adaptBorehole(w).borehole;
  } finally {
    warn.mockRestore();
  }
}

const cell = (b: Borehole, field: string, includeUnreviewed: boolean) => {
  const [metadata] = buildStandardSheets([b], { includeUnreviewed });
  const names = metadata.rows[metadata.headerRow] as string[];
  return metadata.rows[metadata.headerRow + 2][names.indexOf(field)];
};

describe('uiv-13: a confirmed CRS without a CRS value', () => {
  it('is exported in the CoordinateSystem column, also without drafts (a reviewer confirmed it)', () => {
    const b = confirmedRecord();
    expect(b.values.find((v) => v.field === 'CoordinateSystem')).toBeUndefined();
    expect(cell(b, 'CoordinateSystem', false)).toBe('EPSG:2193');
    expect(cell(b, 'CoordinateSystem', true)).toBe('EPSG:2193');
  });

  it('an inferred or unknown CRS without a value stays blank', () => {
    const inferred = { ...confirmedRecord(), crs: { name: null, code: 'EPSG:2193', status: 'inferred' as const } };
    expect(cell(inferred, 'CoordinateSystem', true)).toBeNull();
    const unknown = { ...confirmedRecord(), crs: { name: null, code: null, status: 'unknown' as const } };
    expect(cell(unknown, 'CoordinateSystem', true)).toBeNull();
  });

  it('no unknown field becomes 0 anywhere in the sheets or the tidy CSV', () => {
    const w = fixture<WireBorehole>('borehole');
    w.rock_head_m = null;
    delete w.provenance.rock_head_m;
    w.metadata.surface_elevation_mASL = null;
    delete w.provenance['metadata.surface_elevation_mASL'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = adaptBorehole(w).borehole;
    warn.mockRestore();
    const zeros = (rows: unknown[][]) => rows.flat().filter((c) => c === 0 || c === '0' || c === '0.00').length;
    // The fixture's only printed zero is the first layer's top at 0.00 m.
    const [, logdata] = buildStandardSheets([b], { includeUnreviewed: true });
    expect(logdata.rows[logdata.headerRow + 2][1]).toBe(0);
    const sheets = buildStandardSheets([b], { includeUnreviewed: true });
    expect(sheets.map((s) => zeros(s.rows))).toEqual([0, 1, 0, 0]);
    expect(zeros(tidyRows([b], { includeUnreviewed: true }))).toBe(0);
  });
});
