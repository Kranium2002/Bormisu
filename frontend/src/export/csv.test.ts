import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../config';
import { K } from '../domain/keys';
import { applyValuePatch, flagPatch } from '../domain/review';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { openQuestionRows, tidyRows, toCsv } from './csv';
import { exportPrefix } from './download';

describe('tidyRows', () => {
  it('exports approved values only, unless drafting', () => {
    const b = applyValuePatch(makeBorehole(), K.finalDepth, { status: 'approved' });
    const rows = tidyRows([b], { includeUnreviewed: false });
    expect(rows[0]).toEqual(['borehole', 'field', 'layer', 'raw', 'value', 'unit', 'page', 'method', 'status', 'state']);
    expect(rows.slice(1)).toEqual([['TB-01', K.finalDepth, '', '6,00 m', '6.00', 'm', 1, 'Read', 'approved', 'ok']]);
    expect(tidyRows([b], { includeUnreviewed: true })).toHaveLength(1 + b.values.length);
  });

  it('blanks values whose state is not ok', () => {
    const b = applyValuePatch(makeBorehole(), K.finalDepth, { state: 'not in source', status: 'approved' });
    expect(tidyRows([b], { includeUnreviewed: false })[1][4]).toBe('');
  });

  it('includes the new fields, samples and test results, and names a spreadsheet cell as the source', () => {
    const b = makeBorehole();
    b.values = [
      ...b.values,
      makeValue({ key: K.boreholeName, field: 'BoreholeName', label: 'Borehole name', value: 'North well (fictional)', status: 'approved' }),
      makeValue({ key: K.test(0), field: 'UCS', label: 'UCS', group: 'test', index: 0, value: '12.5', unit: 'MPa', page: null, cell: 'Lab!D7', status: 'approved' }),
    ];
    expect(tidyRows([b], { includeUnreviewed: false }).slice(1)).toEqual([
      ['TB-01', 'Borehole name', '', '', 'North well (fictional)', '', 1, 'Read', 'approved', 'ok'],
      ['TB-01', 'UCS', '', '', '12.5', 'MPa', 'Lab!D7', 'Read', 'approved', 'ok'],
    ]);
  });
});

describe('openQuestionRows', () => {
  const doc = makeDocument({
    id: 'doc', name: 'test_report.pdf', project: 'Test', pages: [], counts: null,
    completeness: { listed: 3, idPrefix: 'TB-', missing: ['TB-02'], unexpected: [], lint: [] },
  });

  it('lists missing IDs, the inferred CRS, lints, flags and illegible values', () => {
    let b = makeBorehole({ crs: { name: 'Fictional grid', code: null, status: 'inferred' } });
    b = { ...b, values: [...b.values, makeValue({ key: K.crs, kind: 'crs', page: 7 })] };
    b = applyValuePatch(b, K.finalDepth, flagPatch('boundary looks off'));
    b = applyValuePatch(b, K.boreholeId, { state: 'illegible' });
    b = { ...b, values: b.values.map((v) => (v.key === K.gw(0) ? { ...v, lint: { severity: 'warning' as const, message: 'GW below final depth' } } : v)) };
    expect(openQuestionRows([b], doc)).toEqual([
      ['borehole', 'page', 'question'],
      ['TB-02', '', 'Report names this borehole but no log was found. Please supply.'],
      ['all', 7, 'Coordinate system not stated. Please confirm (we infer Fictional grid).'],
      ['TB-01', 1, `${K.boreholeId} is illegible in the source.`],
      ['TB-01', 1, `${K.finalDepth}: boundary looks off`],
      ['TB-01', 1, 'GW below final depth'],
    ]);
  });

  it('asks for the transformation of an unknown CRS', () => {
    const b = makeBorehole({ crs: { name: null, code: null, status: 'unknown' } });
    expect(openQuestionRows([b], null)[1][2]).toMatch(/Coordinate system unknown/);
  });

  it('PRIMARY-PAGE-NULL: a borehole without pages gets no page number; a spreadsheet CRS names its cell', () => {
    const unknown = makeBorehole({ pages: [], primaryPage: null, crs: { name: null, code: null, status: 'unknown' }, values: [] });
    expect(openQuestionRows([unknown], null)[1]).toEqual(['TB-01', null, 'Coordinate system unknown. Please supply it, or the transformation to a known one.']);
    const inferred = makeBorehole({
      pages: [], primaryPage: null, crs: { name: null, code: null, status: 'inferred' },
      values: [makeValue({ key: K.crs, kind: 'crs', page: null, cell: 'Logdata!B2' })],
    });
    expect(openQuestionRows([inferred], null)[1]).toEqual(['all', 'Logdata!B2', 'Coordinate system not stated. Please confirm.']);
    const bare = { ...inferred, values: [] };
    expect(openQuestionRows([bare], null)[1][1]).toBeNull();
  });

  it('names the value of a lint the app added itself, whose message does not', () => {
    const b = makeBorehole();
    b.values = [
      ...b.values,
      makeValue({ key: K.spt(1), label: 'SPT @ 1.50 m', page: 3, lint: { severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8', client: true } }),
    ];
    expect(openQuestionRows([b], null).slice(1)).toEqual([['TB-01', 3, 'SPT @ 1.50 m: Increments 4 + 5 = 9 ≠ N 8']]);
  });
});

describe('toCsv', () => {
  it('quotes every cell, escapes quotes and blanks null', () => {
    expect(toCsv([['a', null, 3], ['say "hi"', '', 0]])).toBe('"a","","3"\n"say ""hi""","","0"');
  });
});

describe('exportPrefix', () => {
  it('takes the first token of a file name', () => {
    expect(exportPrefix('site_report_2019.pdf')).toBe('site');
    expect(exportPrefix('')).toBe(APP_NAME.toLowerCase());
  });
});
