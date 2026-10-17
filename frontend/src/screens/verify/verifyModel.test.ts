import { describe, expect, it } from 'vitest';
import { parseLocation, routePath, verifyPath } from '../../routing/urlState';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { fontSizeFor, neighbours, pageItems, pickPage, placementOf, stepZoom, verifyPages } from './verifyModel';

const box = { x: 0.1, y: 0.2, w: 0.2, h: 0.03 };

describe('verifyModel', () => {
  const b = makeBorehole({
    pages: [2],
    values: [
      makeValue({ key: 'depth', label: 'Final depth', raw: '18,00 m', value: '18.00', unit: 'm', page: 3, box, confidence: 0.6 }),
      makeValue({ key: 'id', label: 'Borehole ID', raw: 'BK 7', value: 'BK-07', page: 3, box, status: 'approved' }),
      makeValue({ key: 'method', label: 'Method', raw: 'Rotary', value: 'Rotary', page: 3, box: null }),
      makeValue({ key: 'guess', label: 'Elevation', raw: '', value: '212.4', unit: 'm', page: 3, box, method: 'Guessed' }),
      makeValue({ key: 'nosrc', label: 'Datum', value: 'NN', page: 5, box, hasProvenance: false }),
      makeValue({ key: 'other', label: 'UCS', value: '12', page: 9, box, documentId: 'doc_OTHER' }),
    ],
  });

  it('lists the pages that carry the values (own document only) with the read pages', () => {
    expect(verifyPages(b)).toEqual([2, 3, 5]);
  });

  it('splits a page into boxed and unboxed values, coloured by certainty, with the raw text in the tooltip', () => {
    const { boxed, unboxed } = pageItems(b, 3);
    expect(boxed.map((i) => [i.key, i.text, i.certainty.kind, i.placement])).toEqual([
      ['depth', '18.00 m', 'unsure', 'exact'],
      ['id', 'BK-07', 'sure', 'exact'],
      ['guess', '212.4 m', 'unsure', 'approx'],
    ]);
    expect(unboxed.map((i) => i.key)).toEqual(['method']);
    expect(boxed[0].title).toContain('As printed: 18,00 m');
    expect(boxed[0].title).toContain('Confidence: 60 %');
    expect(pageItems(b, 5).boxed[0].lockedReason).toBe(NO_SOURCE_REFERENCE);
  });

  it('accepts the coming backend methods "approximate" and "page"', () => {
    expect(placementOf({ method: 'approximate', box })).toBe('approx');
    expect(placementOf({ method: 'page', box })).toBe('page');
    expect(placementOf({ method: 'Read', box, flag: 'position approximate' })).toBe('approx');
    expect(placementOf({ method: 'OCR', box })).toBe('exact');
  });

  it('picks the page from the URL when the document has it, and steps among the borehole pages', () => {
    expect(pickPage(null, [2, 3, 5], 12)).toBe(2);
    expect(pickPage(7, [2, 3, 5], 12)).toBe(7);
    expect(pickPage(40, [2, 3, 5], 12)).toBe(2);
    expect(neighbours([2, 3, 5], 3)).toEqual({ prev: 2, next: 5 });
    expect(neighbours([2, 3, 5], 4)).toEqual({ prev: 3, next: 5 });
    expect(neighbours([2, 3, 5], 2)).toEqual({ prev: null, next: 3 });
  });

  it('zooms on a 25 % grid and sizes text to its box', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.75);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    // 0.03 × 780 px tall box → about 16.8 px, unless the text is too long for its width.
    expect(fontSizeFor('BK-07', box, 560, 780)).toBe(16.8);
    expect(fontSizeFor('a very long normalised value', box, 560, 780)).toBe(6);
  });

  it('has a /verify/:uid?page=n route', () => {
    expect(verifyPath('nb:BK-07', 3)).toBe('/verify/nb%3ABK-07?page=3');
    expect(parseLocation('/verify/nb%3ABK-07', '?page=3')).toEqual({ kind: 'verify', uid: 'nb:BK-07', page: 3 });
    expect(parseLocation('/verify/x', '?page=0')).toEqual({ kind: 'verify', uid: 'x', page: null });
    expect(routePath({ kind: 'verify', uid: 'x', page: null })).toBe('/verify/x');
  });
});
