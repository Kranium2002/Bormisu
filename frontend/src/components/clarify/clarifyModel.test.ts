/** F12: the pure model of the clarification UI (fictional questions only). */
import { describe, expect, it } from 'vitest';
import {
  answerValues,
  boreholeText,
  crsOptionCandidates,
  crsQuestionFor,
  evidencePages,
  firstQuestionOf,
  groupByDocument,
  initialInputs,
  KIND_LABEL,
  parseNumber,
  questionsOfBorehole,
  unresolved,
  unresolvedCount,
  valueKeyForPath,
  type FormInputs,
} from './clarifyModel';
import { DOC, DOC_B, makeCandidate, makeClarification, makeEvidence, makeField, UID, UID_B } from './clarifyFixtures';

const open1 = makeClarification({ id: 'cl_1', documentId: DOC, createdAt: '2026-10-17T07:00:00Z' });
const skipped2 = makeClarification({ id: 'cl_2', documentId: DOC_B, status: 'skipped', boreholeUids: [UID_B] });
const open3 = makeClarification({ id: 'cl_3', documentId: DOC, boreholeUids: [UID, UID_B] });
const answered4 = makeClarification({ id: 'cl_4', documentId: DOC, status: 'answered' });

describe('lists, counts and grouping', () => {
  it('unresolved questions are open or skipped; answered ones are not counted', () => {
    expect(unresolved([open1, skipped2, answered4]).map((c) => c.id)).toEqual(['cl_1', 'cl_2']);
    expect(unresolvedCount([open1, skipped2, open3, answered4])).toBe(3);
    expect(unresolvedCount([])).toBe(0);
  });

  it('groups by document in the order of each document’s oldest question, with the file name', () => {
    const groups = groupByDocument([open1, skipped2, open3, answered4], [
      { id: DOC, name: 'fictional-report.pdf' },
      { id: DOC_B, name: 'fictional-labdata.xlsx' },
    ]);
    expect(groups.map((g) => [g.documentId, g.name, g.questions.map((q) => q.id)])).toEqual([
      [DOC, 'fictional-report.pdf', ['cl_1', 'cl_3']],
      [DOC_B, 'fictional-labdata.xlsx', ['cl_2']],
    ]);
  });

  it('a document the app has not loaded keeps its questions, without a made-up name', () => {
    expect(groupByDocument([open1], [])).toEqual([{ documentId: DOC, name: null, questions: [open1] }]);
  });

  it('the first question of a document: open ones before skipped ones, oldest first; none → null', () => {
    const skippedOld = makeClarification({ id: 'cl_0', documentId: DOC, status: 'skipped' });
    expect(firstQuestionOf([skippedOld, open1, open3], DOC)).toBe('cl_1');
    expect(firstQuestionOf([skippedOld], DOC)).toBe('cl_0');
    expect(firstQuestionOf([answered4], DOC)).toBeNull();
    expect(firstQuestionOf([open1], DOC_B)).toBeNull();
  });

  it('the questions of a borehole', () => {
    expect(questionsOfBorehole([open1, skipped2, open3, answered4], UID_B).map((c) => c.id)).toEqual(['cl_2', 'cl_3']);
  });

  it('affected boreholes by their printed IDs; an unknown uid is shown as is', () => {
    expect(boreholeText([UID, UID_B], [{ uid: UID, id: 'BH-1' }])).toBe(`BH-1, ${UID_B}`);
    expect(boreholeText([], [])).toBe('');
  });

  it('every kind has a label', () => {
    for (const k of ['crs_confirm', 'locate_borehole', 'choose_reading', 'datum_convention', 'unit_ambiguous', 'borehole_boundary', 'duplicate', 'conflicting_sources', 'chat_parameter'] as const) {
      expect(KIND_LABEL[k]).toMatch(/\S/);
    }
  });
});

describe('the CRS question of a document', () => {
  const crs = makeClarification({ id: 'cl_crs', kind: 'crs_confirm', documentId: DOC_B, boreholeUids: [UID] });
  it('is the unresolved crs_confirm question of the document or of one of its boreholes', () => {
    expect(crsQuestionFor([open1, crs], DOC_B, [])?.id).toBe('cl_crs');
    expect(crsQuestionFor([open1, crs], DOC, [UID])?.id).toBe('cl_crs');
    expect(crsQuestionFor([open1, crs], DOC, [UID_B])).toBeNull();
    expect(crsQuestionFor([{ ...crs, status: 'answered' }], DOC_B, [])).toBeNull();
  });
});

describe('evidencePages', () => {
  it('one entry per cited page, in the backend’s order, with its boxes and snippets', () => {
    const a = makeEvidence({ page: 6, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, snippet: '9,50' });
    const b = makeEvidence({ page: 6, box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, snippet: null });
    const c = makeEvidence({ documentId: DOC_B, page: 6, box: null, snippet: 'page without a box' });
    const d = makeEvidence({ page: 2, box: null, snippet: null });
    expect(evidencePages([a, c, b, d])).toEqual([
      { documentId: DOC, page: 6, boxes: [a.box, b.box], snippets: ['9,50', null] },
      { documentId: DOC_B, page: 6, boxes: [], snippets: ['page without a box'] },
      { documentId: DOC, page: 2, boxes: [], snippets: [] },
    ]);
  });
});

describe('valueKeyForPath', () => {
  it('a value whose key is the path, or that lists the path among its source paths', () => {
    const values = [{ key: 'BoreholeDepth', paths: ['metadata.borehole_depth_m'] }, { key: 'stratigraphy[2].spt_raw' }];
    expect(valueKeyForPath(values, 'metadata.borehole_depth_m')).toBe('BoreholeDepth');
    expect(valueKeyForPath(values, 'stratigraphy[2].spt_raw')).toBe('stratigraphy[2].spt_raw');
    expect(valueKeyForPath(values, 'metadata.depth_origin')).toBeNull();
    expect(valueKeyForPath(values, null)).toBeNull();
  });
});

describe('parseNumber', () => {
  it('reads a decimal point or comma; anything else is not a number', () => {
    expect(parseNumber('1.95')).toBe(1.95);
    expect(parseNumber(' 1,95 ')).toBe(1.95);
    expect(parseNumber('-12')).toBe(-12);
    expect(parseNumber('.5')).toBe(0.5);
    for (const bad of ['', ' ', 'abc', '1.2.3', '1,2,3', '12 m', 'Infinity', '0x10']) expect(parseNumber(bad), bad).toBeNull();
  });
});

describe('initialInputs: only the server’s defaults, never a made-up value', () => {
  it('fields without a default start empty', () => {
    const fields = [
      makeField({ name: 't', widget: 'text' }),
      makeField({ name: 'n', widget: 'number_unit', unitOptions: ['m', 'ft'] }),
      makeField({ name: 's', widget: 'select', options: [{ value: 'a', label: 'A', evidence: null }] }),
      makeField({ name: 'b', widget: 'boolean' }),
      makeField({ name: 'p', widget: 'map_point' }),
      makeField({ name: 'r', widget: 'choose_reading', options: [{ value: 9.5, label: '9,50', evidence: null }] }),
      makeField({ name: 'g', widget: 'page_range' }),
      makeField({ name: 'c', widget: 'crs_picker', options: [{ value: 'EPSG:0001', label: 'Fictional', evidence: null }] }),
    ];
    expect(initialInputs(fields)).toEqual({
      t: { kind: 'text', text: '' },
      n: { kind: 'number_unit', number: '', unit: '' },
      s: { kind: 'choice', index: null, none: false },
      b: { kind: 'boolean', value: null },
      p: { kind: 'point', lat: '', lon: '' },
      r: { kind: 'choice', index: null, none: false },
      g: { kind: 'range', from: '', to: '' },
      c: { kind: 'choice', index: null, none: false },
    });
  });

  it('a null default (the wire’s "no default") is no default, also for an option whose value is null', () => {
    const fields = [
      makeField({ name: 's', widget: 'select', options: [{ value: null, label: 'none', evidence: null }], default: null }),
      makeField({ name: 'b', widget: 'boolean', default: null }),
      makeField({ name: 't', widget: 'text', default: null }),
      makeField({ name: 'n', widget: 'number_unit', unitOptions: ['m'], default: null }),
    ];
    expect(initialInputs(fields)).toEqual({
      s: { kind: 'choice', index: null, none: false },
      b: { kind: 'boolean', value: null },
      t: { kind: 'text', text: '' },
      n: { kind: 'number_unit', number: '', unit: '' },
    });
  });

  it('defaults fill the inputs; an option default selects the option with the same value', () => {
    const fields = [
      makeField({ name: 't', widget: 'text', default: 'as printed' }),
      makeField({ name: 'n', widget: 'number_unit', unitOptions: ['kN/m3', 't/m3'], default: 19.6 }),
      makeField({ name: 'nu', widget: 'number_unit', unitOptions: ['m', 'ft'], default: { value: 3, unit: 'ft' } }),
      makeField({ name: 's', widget: 'select', options: [{ value: { a: 1 }, label: 'A', evidence: null }, { value: { a: 2 }, label: 'B', evidence: null }], default: { a: 2 } }),
      makeField({ name: 'b', widget: 'boolean', default: false }),
      makeField({ name: 'p', widget: 'map_point', default: { lat: -41.2, lon: 174.7 } }),
      makeField({ name: 'g', widget: 'page_range', default: [3, 4] }),
      makeField({ name: 'x', widget: 'select', options: [{ value: 'a', label: 'A', evidence: null }], default: 'not an option' }),
    ];
    expect(initialInputs(fields)).toEqual({
      t: { kind: 'text', text: 'as printed' },
      // The number is the server's; the unit is left to the reviewer.
      n: { kind: 'number_unit', number: '19.6', unit: '' },
      nu: { kind: 'number_unit', number: '3', unit: 'ft' },
      s: { kind: 'choice', index: 1, none: false },
      b: { kind: 'boolean', value: false },
      p: { kind: 'point', lat: '-41.2', lon: '174.7' },
      g: { kind: 'range', from: '3', to: '4' },
      x: { kind: 'choice', index: null, none: false },
    });
  });
});

describe('answerValues: inputs → the answer the server gets', () => {
  const reading = makeField({
    name: 'reading', widget: 'choose_reading', required: true,
    options: [{ value: 9.5, label: '9,50', evidence: null }, { value: 9.8, label: '9,80', evidence: null }],
  });
  const all = [
    makeField({ name: 'note', widget: 'text' }),
    makeField({ name: 'value', widget: 'number_unit', required: true, unitOptions: ['kN/m3', 't/m3'] }),
    makeField({ name: 'origin', widget: 'select', required: true, options: [{ value: 'ground', label: 'Ground', evidence: null }, { value: 'relative', label: 'Deck', evidence: null }] }),
    makeField({ name: 'same', widget: 'boolean', required: true }),
    makeField({ name: 'location', widget: 'map_point', required: true }),
    reading,
    makeField({ name: 'pages', widget: 'page_range', required: true }),
    makeField({ name: 'crs', widget: 'crs_picker', required: true, options: [{ value: 'EPSG:0001', label: 'Fictional', evidence: null }] }),
  ];
  const filled: FormInputs = {
    note: { kind: 'text', text: '  from the site plan  ' },
    value: { kind: 'number_unit', number: '1,95', unit: 't/m3' },
    origin: { kind: 'choice', index: 1, none: false },
    same: { kind: 'boolean', value: false },
    location: { kind: 'point', lat: '-41.28', lon: '174.77' },
    reading: { kind: 'choice', index: 1, none: false },
    pages: { kind: 'range', from: '3', to: '4' },
    crs: { kind: 'choice', index: 0, none: false },
  };

  it('every widget gives the contract’s value shape', () => {
    expect(answerValues(all, filled, { pageCount: 12 })).toEqual({
      errors: {},
      values: {
        note: 'from the site plan',
        value: { value: 1.95, unit: 't/m3' },
        origin: 'relative',
        same: false,
        location: { lat: -41.28, lon: 174.77 },
        reading: 9.8,
        pages: [3, 4],
        crs: 'EPSG:0001',
      },
    });
  });

  it('a required field left empty is an error next to it; nothing is sent for it', () => {
    const empty = initialInputs(all);
    const { values, errors } = answerValues(all, empty, { pageCount: null });
    expect(values).toEqual({});
    expect(Object.keys(errors).sort()).toEqual(['crs', 'location', 'origin', 'pages', 'reading', 'same', 'value']);
    expect(errors.value).toBe('Enter a number.');
    expect(errors.reading).toBe('Choose one of the readings.');
    expect(errors.same).toBe('Choose yes or no.');
    expect(errors.location).toBe('Click the map or enter the latitude and longitude.');
  });

  it('an empty optional field is left out; "none of these" sends null', () => {
    const optional = { ...reading, required: false };
    const r = answerValues([makeField({ name: 'note', widget: 'text' }), optional], { note: { kind: 'text', text: ' ' }, reading: { kind: 'choice', index: null, none: true } }, { pageCount: null });
    expect(r).toEqual({ values: { reading: null }, errors: {} });
  });

  it('checks numbers, units, coordinates and pages before sending', () => {
    const bad: FormInputs = {
      ...filled,
      value: { kind: 'number_unit', number: '1.9.5', unit: '' },
      location: { kind: 'point', lat: '95', lon: '10' },
      pages: { kind: 'range', from: '5', to: '3' },
    };
    const { errors } = answerValues(all, bad, { pageCount: 12 });
    expect(errors.value).toBe('Enter a number, for example 1.95.');
    expect(errors.location).toBe('The latitude must be between -90 and 90.');
    expect(errors.pages).toBe('The first page must not come after the last.');

    const unit = answerValues(all, { ...filled, value: { kind: 'number_unit', number: '2', unit: '' } }, { pageCount: 12 }).errors;
    expect(unit.value).toBe('Choose a unit.');
    const lon = answerValues(all, { ...filled, location: { kind: 'point', lat: '10', lon: '-181' } }, { pageCount: 12 }).errors;
    expect(lon.location).toBe('The longitude must be between -180 and 180.');
    const half = answerValues(all, { ...filled, location: { kind: 'point', lat: '10', lon: '' } }, { pageCount: 12 }).errors;
    expect(half.location).toBe('Click the map or enter the latitude and longitude.');
    const out = answerValues(all, { ...filled, pages: { kind: 'range', from: '3', to: '13' } }, { pageCount: 12 }).errors;
    expect(out.pages).toBe('Pages are whole numbers from 1 to 12.');
    const halfRange = answerValues(all, { ...filled, pages: { kind: 'range', from: '3', to: ' ' } }, { pageCount: 12 }).errors;
    expect(halfRange.pages).toBe('Enter the first and the last page.');
    const frac = answerValues(all, { ...filled, pages: { kind: 'range', from: '1.5', to: '2' } }, { pageCount: null }).errors;
    expect(frac.pages).toBe('Pages are whole numbers from 1.');
  });

  it('a number without unit options goes without a unit', () => {
    const f = makeField({ name: 'v', widget: 'number_unit', required: true });
    expect(answerValues([f], { v: { kind: 'number_unit', number: '7', unit: '' } }, { pageCount: null }).values).toEqual({ v: { value: 7, unit: null } });
  });
});

describe('crsOptionCandidates: options matched to the document’s candidates by code', () => {
  const field = makeField({
    name: 'crs', widget: 'crs_picker',
    options: [
      { value: 'EPSG:0001', label: 'Fictional A', evidence: null },
      { value: 'EPSG:0002', label: 'Fictional B', evidence: null },
      { value: 'EPSG:0003', label: 'Fictional C', evidence: null },
    ],
  });
  const a = makeCandidate({ code: 'EPSG:0001', verdict: 'match', score: 1 });
  const aSwapped = makeCandidate({ code: 'EPSG:0001', verdict: 'match', score: 0.9, swapAxes: true });
  const b = makeCandidate({ code: 'EPSG:0002', verdict: 'shifted' });

  it('takes the candidate with the chosen axis order, else the first listed; an unmatched option has none', () => {
    expect(crsOptionCandidates(field, [a, aSwapped, b], null)).toEqual([a, b, null]);
    expect(crsOptionCandidates(field, [a, aSwapped, b], true)).toEqual([aSwapped, b, null]);
    expect(crsOptionCandidates(field, [a, aSwapped, b], false)).toEqual([a, b, null]);
    expect(crsOptionCandidates(field, [], null)).toEqual([null, null, null]);
  });
});
