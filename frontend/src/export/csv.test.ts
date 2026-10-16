import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import { applyValuePatch, flagPatch } from '../domain/review';
import type { DocumentSummary } from '../domain/types';
import { makeBorehole, makeValue } from '../test/fixtures';
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
});

describe('openQuestionRows', () => {
  const doc: DocumentSummary = {
    id: 'doc', name: 'test_report.pdf', project: 'Test', pageTypes: [], step: 2, counts: null, reviewBoreholeUid: null,
    completeness: { listed: 3, idPrefix: 'TB-', missing: ['TB-02'], unexpected: [], lint: [] },
  };

  it('lists missing IDs, the inferred CRS, lints, flags and illegible values', () => {
    let b = makeBorehole({ crs: { name: 'DHDN / GK zone 3', code: null, status: 'inferred' } });
    b = { ...b, values: [...b.values, makeValue({ key: K.crs, kind: 'crs', page: 7 })] };
    b = applyValuePatch(b, K.finalDepth, flagPatch('boundary looks off'));
    b = applyValuePatch(b, K.boreholeId, { state: 'illegible' });
    b = { ...b, values: b.values.map((v) => (v.key === K.gwStrike ? { ...v, lint: { severity: 'warning' as const, message: 'GW below final depth' } } : v)) };
    expect(openQuestionRows([b], doc)).toEqual([
      ['borehole', 'page', 'question'],
      ['TB-02', '', 'Report names this borehole but no log was found. Please supply.'],
      ['all', 7, 'Coordinate system not stated. Please confirm (we infer DHDN / GK zone 3).'],
      ['TB-01', 1, `${K.boreholeId} is illegible in the scan.`],
      ['TB-01', 1, `${K.finalDepth}: boundary looks off`],
      ['TB-01', 1, 'GW below final depth'],
    ]);
  });

  it('asks for the transformation of an unknown CRS', () => {
    const b = makeBorehole({ crs: { name: null, code: null, status: 'unknown' } });
    expect(openQuestionRows([b], null)[1][2]).toMatch(/Coordinate system unknown/);
  });
});

describe('toCsv', () => {
  it('quotes every cell, escapes quotes and blanks null', () => {
    expect(toCsv([['a', null, 3], ['say "hi"', '', 0]])).toBe('"a","","3"\n"say ""hi""","","0"');
  });
});

describe('exportPrefix', () => {
  it('takes the first token of a file name', () => {
    expect(exportPrefix('neckarbogen_BG_2019.pdf')).toBe('neckarbogen');
    expect(exportPrefix('')).toBe('bormisu');
  });
});
