import { describe, expect, it } from 'vitest';
import { adaptBorehole, type WireBorehole } from '../../data/adapters';
import { K } from '../../domain/keys';
import { initialFocusKey } from '../../domain/review';
import type { Borehole, Box, CrsCandidate } from '../../domain/types';
import { fixture } from '../../test/contract/wire';
import { makeBorehole, makeMeta, makeValue } from '../../test/fixtures';
import {
  boxVariant,
  crsActionKey,
  crsIntro,
  fieldNote,
  normalisedText,
  pageText,
  readingText,
  reviewRows,
  rowKeys,
  scanBoxes,
  scanCaption,
  scoreText,
  sheetPages,
  siblings,
  siteCentre,
  sptTitle,
} from './reviewView';

const box = (x: number, y: number): Box => ({ x, y, w: 0.1, h: 0.02 });
const noop = () => {};

describe('reviewRows', () => {
  it('groups BOREHOLE, GROUNDWATER and LAYER n with range and page', () => {
    const b = makeBorehole();
    const heads = reviewRows(b).flatMap((r) => (r.kind === 'head' ? [r.title] : []));
    expect(heads).toEqual(['BOREHOLE', 'GROUNDWATER', 'LAYER 1 · 0.00–2.50 M · P.1', 'LAYER 2 · 2.50–6.00 M · P.1']);
  });

  it('puts samples and test results last, under SAMPLES and TEST RESULTS', () => {
    const b = makeBorehole();
    b.values = [
      makeValue({ key: K.test(0), field: 'UCS', group: 'test', index: 0 }),
      makeValue({ key: K.sampleName(0), field: 'SampleName', group: 'sample', index: 0 }),
      ...b.values,
    ];
    const heads = reviewRows(b).flatMap((r) => (r.kind === 'head' ? [r.title] : []));
    expect(heads.slice(-2)).toEqual(['SAMPLES', 'TEST RESULTS']);
    expect(rowKeys(reviewRows(b)).slice(-2)).toEqual([K.sampleName(0), K.test(0)]);
  });

  it('orders values by group even when the source interleaves them', () => {
    const b = makeBorehole();
    const shuffled = { ...b, values: [...b.values].reverse() };
    const keys = rowKeys(reviewRows(shuffled));
    expect(keys.slice(0, 2).sort()).toEqual([K.boreholeId, K.finalDepth].sort());
    expect(keys[2]).toBe(K.gw(0));
    expect(keys.slice(3, 5).every((k) => k.startsWith('layer[1]'))).toBe(true);
  });
});

describe('scan boxes and caption', () => {
  it('lists the pages of the values as sheets; a spreadsheet has none', () => {
    const b = makeBorehole({
      values: [makeValue({ key: 'a', page: 8 }), makeValue({ key: 'b', page: 7 }), makeValue({ key: 'c', page: 8 })],
    });
    expect(sheetPages(b)).toEqual([7, 8]);
    const sheet = makeBorehole({ values: [makeValue({ key: 'a', page: null, cell: 'Logdata!C5' })] });
    expect(sheetPages(sheet)).toEqual([]);
  });

  it('styles boxes by state: focus > flagged > lint > approved > idle', () => {
    const v = makeValue({ key: 'x', lint: { severity: 'error', message: 'bad' } });
    expect(boxVariant(v, true)).toBe('focus');
    expect(boxVariant({ ...v, status: 'flagged' }, false)).toBe('flagged');
    expect(boxVariant(v, false)).toBe('lint');
    expect(boxVariant({ ...v, status: 'approved' }, false)).toBe('approved');
    expect(boxVariant({ ...v, lint: undefined }, false)).toBe('idle');
  });

  it('draws a repeated box (CRS on the X / Y line) only while it is focused, on top', () => {
    const shared = box(0.2, 0.2);
    const b = makeBorehole({
      values: [
        makeValue({ key: K.xy, page: 7, box: shared }),
        makeValue({ key: K.crs, page: 7, box: { ...shared }, kind: 'crs' }),
        makeValue({ key: 'other', page: 8, box: box(0.5, 0.5) }),
      ],
    });
    expect(scanBoxes(b, 7, K.xy, noop).map((x) => x.id)).toEqual([K.xy]);
    const focusedCrs = scanBoxes(b, 7, K.crs, noop);
    expect(focusedCrs.map((x) => [x.id, x.variant])).toEqual([
      [K.xy, 'idle'],
      [K.crs, 'focus'],
    ]);
  });

  it('gives a shared box to the printed value, not the derived one listed before it', () => {
    const shared = box(0.2, 0.4);
    const b = makeBorehole({
      values: [
        makeValue({ key: K.rockHead, page: 8, box: shared, method: 'Derived' }),
        makeValue({ key: K.lithology(6), group: 'layer', layer: 6, page: 8, box: { ...shared }, method: 'OCR' }),
      ],
    });
    expect(scanBoxes(b, 8, null, noop).map((x) => x.id)).toEqual([K.lithology(6)]);
    expect(scanBoxes(b, 8, K.rockHead, noop).map((x) => x.id)).toEqual([K.lithology(6), K.rockHead]);
  });

  it('says "box not found, page shown" for a focused value without a box', () => {
    const v = makeValue({ key: 'm', label: 'Drilling method', page: 7, box: null });
    expect(scanCaption(7, [7, 8], v)).toEqual({ text: 'Drilling method: box not found, page shown', tone: 'warn' });
    expect(scanCaption(8, [7, 8], { ...v, box: box(0, 0) }).text).toBe(
      'page 8 · sheet 2 of 2 · click a box to jump to its field',
    );
    expect(scanCaption(7, [7, 8], { ...v, state: 'not in source' }).tone).toBe('normal');
  });

  it('explains a spreadsheet cell and a value without a source reference', () => {
    const cell = makeValue({ key: 'c', label: 'UCS', page: null, cell: 'Lab!D7' });
    expect(scanCaption(1, [], cell)).toEqual({ text: 'UCS: spreadsheet cell Lab!D7, no page image', tone: 'normal' });
    const orphan = makeValue({ key: 'o', label: 'Casing', hasProvenance: false, page: null });
    expect(scanCaption(1, [], orphan)).toEqual({ text: 'Casing: no source reference from the backend', tone: 'warn' });
  });

  it('shows the page, the cell or the missing reference next to the label', () => {
    expect(pageText(makeValue({ key: 'a', page: 7, box: box(0, 0) }))).toBe('p.7');
    expect(pageText(makeValue({ key: 'a', page: 7, box: null }))).toBe('p.7 · no box');
    expect(pageText(makeValue({ key: 'a', page: null }))).toBe('');
    expect(pageText(makeValue({ key: 'a', page: null, cell: 'Sheet!C5' }))).toBe('Sheet!C5');
    expect(pageText(makeValue({ key: 'a', hasProvenance: false }))).toBe('no source reference');
  });
});

describe('values and notes', () => {
  it('adds the unit and marks a confirmed CRS', () => {
    const b = makeBorehole();
    expect(normalisedText(b, makeValue({ key: 'd', value: '18.00', unit: 'm' }))).toBe('18.00 m');
    const crs = makeValue({ key: K.crs, value: 'Fictional grid', kind: 'crs' });
    const confirmed = { ...b, crs: { ...b.crs, status: 'confirmed' as const } };
    expect(normalisedText(confirmed, crs)).toBe('Fictional grid (confirmed)');
  });

  it('explains an inferred CRS with the backend note, without guessing a CRS family', () => {
    const b = makeBorehole({
      crs: { name: 'Fictional grid', code: 'EPSG:0001', status: 'inferred' },
      values: [makeValue({ key: K.xy, value: '3513420 / 5405870' }), makeValue({ key: K.crs, kind: 'crs' })],
    });
    expect(fieldNote(b, b.values[1])).toEqual({ text: 'not stated in source · inferred, confirm it for the document', tone: 'warn' });
    const noted = { ...b.values[1], note: 'matches the site plan' };
    expect(fieldNote(b, noted)?.text).toBe('not stated in source · inferred: matches the site plan');
    expect(JSON.stringify(fieldNote(b, b.values[1]))).not.toMatch(/Rechtswert|7-digit/);
    const confirmed = { ...b, crs: { ...b.crs, status: 'confirmed' as const } };
    expect(fieldNote(confirmed, b.values[1])).toEqual({ text: 'confirmed for the whole document', tone: 'ok' });
    expect(fieldNote(b, makeValue({ key: 'n', note: 'read as DD.MM.YYYY' }))).toEqual({ text: 'read as DD.MM.YYYY', tone: 'faint' });
  });

  it('notes the coordinates as printed on the X / Y row', () => {
    const b = makeBorehole({ meta: makeMeta({ xRaw: '512 000', yRaw: '5 540 000', axisLabelsRaw: 'E / N' }) });
    expect(fieldNote(b, makeValue({ key: K.xy, value: '512000 / 5540000' }))).toEqual({
      text: 'as printed: 512 000 / 5 540 000 (E / N)',
      tone: 'faint',
    });
    expect(fieldNote(makeBorehole(), makeValue({ key: K.xy }))).toBeNull();
  });

  it('FE-CRS-1/2: without a CRS row, the X / Y row names the CRS the server has, or says what is missing', () => {
    const xy = makeValue({ key: K.xy, value: '2037743 / 5706760' });
    const meta = makeMeta({ xRaw: '2037743.0', yRaw: '5706760.0', axisLabelsRaw: null });
    const at = (crs: Borehole['crs']) => fieldNote(makeBorehole({ crs, meta, values: [xy] }), xy);
    expect(at({ name: null, code: 'EPSG:2193', status: 'confirmed' })).toEqual({
      text: 'as printed: 2037743.0 / 5706760.0 · CRS EPSG:2193, confirmed for the whole document',
      tone: 'faint',
    });
    expect(at({ name: null, code: null, status: 'inferred' })).toEqual({
      text: 'as printed: 2037743.0 / 5706760.0 · CRS not stated in source, confirm it for the document',
      tone: 'warn',
    });
    expect(at({ name: null, code: 'EPSG:2193', status: 'inferred' })?.text).toContain('CRS not stated in source · inferred EPSG:2193');
    expect(at({ name: null, code: null, status: 'unknown' })?.text).toContain('CRS not known, so this borehole is not on the map');
    // A stated CRS, or one that has its own row, is not repeated on the X / Y row.
    expect(at({ name: 'NZTM2000', code: 'EPSG:2193', status: 'stated' })).toEqual({ text: 'as printed: 2037743.0 / 5706760.0', tone: 'faint' });
    const withRow = makeBorehole({ crs: { name: null, code: 'EPSG:2193', status: 'confirmed' }, meta, values: [xy, makeValue({ key: K.crs, kind: 'crs' })] });
    expect(fieldNote(withRow, xy)).toEqual({ text: 'as printed: 2037743.0 / 5706760.0', tone: 'faint' });
  });

  it('shows the SPT depth and increments on hover; an unstated depth says so', () => {
    const spt = makeValue({ key: 's', kind: 'spt', spt: { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 } });
    expect(sptTitle(spt)).toBe('SPT at 1.50 m · increments 3 · 4 · 5: N = 4 + 5 (2nd + 3rd)');
    expect(sptTitle({ ...spt, spt: { raw: '50/30', depth: null, refusal: true, blows: 50, penetrationCm: 30 } })).toBe('SPT depth not stated');
    expect(sptTitle(makeValue({ key: 'x' }))).toBeUndefined();
  });

  it('writes readings side by side with their confidence when known', () => {
    expect(readingText({ reader: 'reader A', text: '1,80', confidence: 0.82 })).toBe('reader A: “1,80” · 82 %');
    expect(readingText({ reader: 'reader B', text: '1,30', confidence: null })).toBe('reader B: “1,30”');
  });
});

describe('CRS dialog helpers', () => {
  const cands: CrsCandidate[] = [
    { name: 'A', code: 'EPSG:1', note: null, score: 0.912, verdict: 'match', swapAxes: false, points: [{ uid: 'a', lat: 48, lng: 9 }, { uid: 'b', lat: 50, lng: 11 }] },
    { name: 'B', code: 'EPSG:2', note: null, score: null, verdict: 'out_of_range', swapAxes: false, points: [] },
  ];

  it('centres the site circle on the matching candidate', () => {
    expect(siteCentre(cands)).toEqual({ lat: 49, lng: 10 });
    expect(siteCentre([cands[1]])).toBeNull();
  });

  it('shows the backend score when it sent one', () => {
    expect(scoreText(cands[0])).toBe('score 0.91');
    expect(scoreText(cands[1])).toBe('');
  });

  it('builds the intro from the printed coordinates and the pin count', () => {
    const b = makeBorehole({
      crs: { name: null, code: null, status: 'inferred' },
      values: [makeValue({ key: K.xy, raw: '512 000 · 5 540 000' }), makeValue({ key: K.crs, raw: 'not stated' })],
    });
    expect(crsIntro(b, cands)).toBe(
      'Source prints “512 000 · 5 540 000” with no CRS. Each candidate places the 2 boreholes of this report differently.',
    );
    const withMeta = { ...b, meta: makeMeta({ xRaw: 'E 512 000', yRaw: 'N 5 540 000' }) };
    expect(crsIntro(withMeta, cands)).toContain('“E 512 000 / N 5 540 000”');
  });
});

describe('siblings', () => {
  it('lists reviewable boreholes of the same document in natural ID order', () => {
    const mk = (id: string, documentId: string | null = 'doc') => makeBorehole({ uid: `bh_${id}`, id, documentId });
    const all = [mk('BK-10'), mk('BK-2'), mk('X-1', 'other'), mk('BK-1')];
    expect(siblings(all, all[0]).map((b) => b.id)).toEqual(['BK-1', 'BK-2', 'BK-10']);
  });
});

describe('uiv-14: a coordinate system that was not printed can still be chosen in Review', () => {
  /** The fictional fixture shaped like a seeded log without a printed system: inferred, no CRS value. */
  function unprinted(): Borehole {
    const w = fixture<WireBorehole>('borehole');
    w.crs_status = 'inferred';
    w.plotted = false;
    w.unplotted_reason = 'crs_unconfirmed';
    w.metadata.coordinates = { ...w.metadata.coordinates, coordinate_system: null, crs_code: null, latitude: null, longitude: null };
    delete w.provenance['metadata.coordinates.coordinate_system'];
    return adaptBorehole(w).borehole;
  }

  it('offers CHOOSE CRS… on the X / Y row when the record has no CRS value', () => {
    const b = unprinted();
    expect(b.values.some((v) => v.kind === 'crs')).toBe(false);
    expect(crsActionKey(b)).toBe(K.xy);
    expect(initialFocusKey(b)).toBe(K.xy);
  });

  it('keeps it on the CRS row when there is one', () => {
    const b = makeBorehole({ crs: { name: 'X', code: null, status: 'inferred' } });
    b.values = [...b.values, makeValue({ key: K.xy }), makeValue({ key: K.crs, kind: 'crs' })];
    expect(crsActionKey(b)).toBe(K.crs);
  });

  it('offers nothing without coordinates', () => {
    const b = makeBorehole();
    expect(crsActionKey(b)).toBeNull();
  });
});

describe('uiv-6: a value with a source entry but no page', () => {
  it('the caption says it is on no page instead of "box not found, page shown"', () => {
    const guessed = makeValue({ key: 'c', label: 'Country', page: null, box: null, method: 'Guessed' });
    expect(scanCaption(2, [2], guessed)).toEqual({ text: 'Country: guessed, not printed on a page', tone: 'warn' });
    const derived = makeValue({ key: 'lat', label: 'Latitude', page: null, box: null, method: 'Derived' });
    expect(scanCaption(2, [2], derived)).toEqual({ text: 'Latitude: derived, not printed on a page', tone: 'warn' });
    const read = makeValue({ key: 'x', label: 'Casing', page: null, box: null, method: 'Read' });
    expect(scanCaption(2, [2], read)).toEqual({ text: 'Casing: no page reference from the backend', tone: 'warn' });
  });
});

describe('PRIMARY-PAGE-NULL: a borehole without pages', () => {
  const pageless = () =>
    makeBorehole({ pages: [], primaryPage: null, values: [makeValue({ key: K.boreholeId, page: null, method: 'Guessed' })] });

  it('has no sheet tabs: no page is made up for it', () => {
    expect(sheetPages(pageless())).toEqual([]);
  });

  it('the caption says there is no source page instead of "page null" or page 1', () => {
    expect(scanCaption(null, [], undefined)).toEqual({ text: 'no source page for this borehole', tone: 'normal' });
    expect(scanBoxes(pageless(), null, null, noop)).toEqual([]);
  });
});

describe('DV-11-UI: values whose source is in another document', () => {
  const LAB = 'doc_FICTIONAL_LAB_0000000000001';
  const lab = (o: Parameters<typeof makeValue>[0]) => makeValue({ documentId: LAB, ...o });

  it('are never drawn on the borehole’s own pages, nor add sheet tabs', () => {
    const b = makeBorehole({
      values: [
        makeValue({ key: 'own', page: 7, box: box(0.1, 0.1) }),
        lab({ key: 'ucs', page: 3, box: box(0.2, 0.2) }),
        lab({ key: 'own-doc-id', page: 7, box: box(0.3, 0.3), documentId: makeBorehole().documentId! }),
      ],
    });
    expect(sheetPages(b)).toEqual([7]);
    expect(scanBoxes(b, 3, null, noop)).toEqual([]);
    expect(scanBoxes(b, 7, 'ucs', noop).map((x) => x.id)).toEqual(['own', 'own-doc-id']);
  });

  it('name the other document next to the label and in the caption', () => {
    expect(pageText(lab({ key: 'a', page: 3, box: box(0, 0) }), true)).toBe('p.3 · other document');
    expect(pageText(lab({ key: 'a', page: null, cell: 'Lab!D7' }), true)).toBe('Lab!D7 · other document');
    const cell = lab({ key: 'c', label: 'UCS', page: null, cell: 'Lab!D7' });
    expect(scanCaption(7, [7], cell, true)).toEqual({
      text: 'UCS: spreadsheet cell Lab!D7 in another document · Larger source view shows it',
      tone: 'normal',
    });
    const paged = lab({ key: 'p', label: 'UCS', page: 3, box: box(0, 0) });
    expect(scanCaption(7, [7], paged, true)).toEqual({
      text: 'UCS: page 3 of another document · Larger source view shows it',
      tone: 'normal',
    });
  });

  it('a layer heading names a page of the borehole’s own document only', () => {
    const b = makeBorehole({
      values: [lab({ key: 'l1', group: 'layer', layer: 1, page: 3 }), makeValue({ key: 'l1b', group: 'layer', layer: 1, page: 8 })],
    });
    expect(reviewRows(b)[0]).toMatchObject({ kind: 'head', title: 'LAYER 1 · 0.00–2.50 M · P.8' });
  });
});
