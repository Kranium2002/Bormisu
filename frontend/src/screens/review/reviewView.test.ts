import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { Box, CrsCandidate } from '../../domain/types';
import { makeBorehole, makeValue } from '../../test/fixtures';
import {
  boxVariant,
  crsIntro,
  emptyReview,
  fieldNote,
  normalisedText,
  pageText,
  reviewRows,
  rowKeys,
  scanBoxes,
  scanCaption,
  scanScale,
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
    expect(heads).toEqual(['BOREHOLE', 'GROUNDWATER', 'LAYER 1 · 0.00–2.50 m · p.1', 'LAYER 2 · 2.50–6.00 m · p.1']);
  });

  it('orders values by group even when the source interleaves them', () => {
    const b = makeBorehole();
    const shuffled = { ...b, values: [...b.values].reverse() };
    const keys = rowKeys(reviewRows(shuffled));
    expect(keys.slice(0, 2).sort()).toEqual([K.boreholeId, K.finalDepth].sort());
    expect(keys[2]).toBe(K.gwStrike);
    expect(keys.slice(3, 5).every((k) => k.startsWith('layer[1]'))).toBe(true);
  });
});

describe('scan boxes and caption', () => {
  it('lists the pages of the values as sheets', () => {
    const b = makeBorehole({
      values: [makeValue({ key: 'a', page: 8 }), makeValue({ key: 'b', page: 7 }), makeValue({ key: 'c', page: 8 })],
    });
    expect(sheetPages(b)).toEqual([7, 8]);
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

  it('scales the page to the pane width, between 0.95 and 1.45', () => {
    expect(scanScale(660)).toBe(1);
    expect(scanScale(625)).toBe(0.95);
    expect(scanScale(800)).toBe(1.25);
    expect(scanScale(1400)).toBe(1.45);
    expect(scanScale(0)).toBe(0.95);
  });

  it('shows the page and "no box" next to the label', () => {
    expect(pageText(makeValue({ key: 'a', page: 7, box: box(0, 0) }))).toBe('p.7');
    expect(pageText(makeValue({ key: 'a', page: 7, box: null }))).toBe('p.7 · no box');
    expect(pageText(makeValue({ key: 'a', page: null }))).toBe('');
  });
});

describe('values and notes', () => {
  it('adds the unit and marks a confirmed CRS', () => {
    const b = makeBorehole();
    expect(normalisedText(b, makeValue({ key: 'd', value: '18.00', unit: 'm' }))).toBe('18.00 m');
    const crs = makeValue({ key: K.crs, value: 'DHDN / GK zone 3', kind: 'crs' });
    const confirmed = { ...b, crs: { ...b.crs, status: 'confirmed' as const } };
    expect(normalisedText(confirmed, crs)).toBe('DHDN / GK zone 3 (confirmed)');
  });

  it('explains an inferred CRS from a 7-digit Rechtswert', () => {
    const b = makeBorehole({
      crs: { name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' },
      values: [makeValue({ key: K.xy, value: '3513420 / 5405870' }), makeValue({ key: K.crs, kind: 'crs' })],
    });
    expect(fieldNote(b, b.values[1])).toEqual({
      text: 'not stated in source · inferred from 7-digit Rechtswert',
      tone: 'warn',
    });
    const confirmed = { ...b, crs: { ...b.crs, status: 'confirmed' as const } };
    expect(fieldNote(confirmed, b.values[1])?.tone).toBe('ok');
    expect(fieldNote(b, makeValue({ key: 'n', note: 'read as DD.MM.YYYY' }))).toEqual({ text: 'read as DD.MM.YYYY', tone: 'faint' });
  });

  it('shows SPT increments on hover, but not for a refusal', () => {
    const spt = makeValue({ key: 's', kind: 'spt', spt: { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 } });
    expect(sptTitle(spt)).toBe('Increments 3 · 4 · 5: N = 4 + 5 (2nd + 3rd)');
    expect(sptTitle({ ...spt, spt: { raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 } })).toBeUndefined();
  });
});

describe('CRS dialog helpers', () => {
  const cands: CrsCandidate[] = [
    { name: 'A', code: 'EPSG:1', note: '', verdict: 'match', points: [{ uid: 'a', lat: 48, lng: 9 }, { uid: 'b', lat: 50, lng: 11 }] },
    { name: 'B', code: 'EPSG:2', note: '', verdict: 'out_of_range', points: [] },
  ];

  it('centres the site circle on the matching candidate', () => {
    expect(siteCentre(cands)).toEqual({ lat: 49, lng: 10 });
    expect(siteCentre([cands[1]])).toBeNull();
  });

  it('builds the intro from the printed X / Y and the pin count', () => {
    const b = makeBorehole({
      crs: { name: null, code: null, status: 'inferred' },
      values: [makeValue({ key: K.xy, raw: 'R 3 513 420 · H 5 405 870' }), makeValue({ key: K.crs, raw: 'not stated' })],
    });
    expect(crsIntro(b, cands)).toBe(
      'Source prints “R 3 513 420 · H 5 405 870” with no CRS. Each candidate places the 2 boreholes of this report differently.',
    );
  });
});

describe('siblings', () => {
  it('lists reviewable boreholes of the same document in natural ID order', () => {
    const mk = (id: string, documentId: string | null = 'doc') => makeBorehole({ uid: `doc:${id}`, id, documentId });
    const all = [mk('BK-10'), mk('BK-2'), mk('X-1', 'other'), mk('BK-1')];
    expect(siblings(all, all[0]).map((b) => b.id)).toEqual(['BK-1', 'BK-2', 'BK-10']);
  });
});

describe('emptyReview', () => {
  it('explains boreholes without source pages, and asks for an upload when there are none', () => {
    expect(emptyReview(true, false)).toEqual({
      message: 'These boreholes have no source pages from the backend yet, so there is nothing to check them against.',
      action: { label: 'OPEN MAP ›', screen: 'map' },
    });
    expect(emptyReview(false, false).action).toEqual({ label: 'OPEN UPLOAD & QUEUE ›', screen: 'queue' });
    expect(emptyReview(false, false).message).toMatch(/^No report is ready for review yet/);
    expect(emptyReview(true, true).action.screen).toBe('queue');
  });
});
