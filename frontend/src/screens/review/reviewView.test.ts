import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { Box, CrsCandidate } from '../../domain/types';
import { makeBorehole, makeMeta, makeValue } from '../../test/fixtures';
import {
  boxVariant,
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
